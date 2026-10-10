/**
 * Cells and rows of the S3 preview. Browser-safe and pure. `JSON.stringify` is never
 * called on a stored or decoded value: nested values are written by `serializeBounded`, iteratively, with an explicit
 * stack, stopping at the cell bound and at the nesting bound.
 */
import { QueryError } from "@/lib/db/errors";
import { S3_PREVIEW_LIMITS, S3_TYPE, type S3PreviewLimits } from "./constants";
import type { S3PreviewCell, S3PreviewColumn, S3PreviewRows } from "./preview";
import { previewSentence, spellName } from "./preview-render";

const count = (value: number): string => value.toLocaleString("en-US");
const hex2 = (byte: number): string => byte.toString(16).padStart(2, "0");

/** `text` cut at `cap` UTF-16 units, never between the two halves of a surrogate pair (as `applySourceBound`). */
export function cutText(text: string, cap: number): { readonly text: string; readonly cut: boolean } {
  if (text.length <= cap) return { text, cut: false };
  const cut = text.slice(0, cap);
  const last = cut.charCodeAt(cut.length - 1);
  return { text: last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut, cut: true };
}

/** A Date as ISO text without the trailing Z; an invalid Date as its time value. */
function dateText(value: Date): string {
  const time = value.getTime();
  return Number.isNaN(time) ? String(time) : value.toISOString().slice(0, -1);
}

/** Lowercase hex pairs of as many bytes as fit beside ` ({n} bytes)`, a suffix that is never cut (Kafka's precedent). */
function bytesCell(bytes: Uint8Array, cellChars: number): { readonly cell: string; readonly cut: boolean } {
  const suffix = ` (${count(bytes.length)} bytes)`;
  const pairs = Math.min(bytes.length, Math.floor(Math.max(0, cellChars - suffix.length) / 2));
  return { cell: `${Array.from(bytes.subarray(0, pairs), hex2).join("")}${suffix}`, cut: pairs < bytes.length };
}

const NAMED_CONTROL: Readonly<Record<number, string>> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
const unicodeEscape = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

/**
 * A JSON string literal, escaped as JSON.stringify escapes one (quote, backslash, C0 controls, lone surrogates),
 * written by one loop over the code units rather than by calling it or by a control-character regular expression.
 * Only the first `budget` + 1 input characters are escaped (a pair at that edge is kept whole), and a literal cut
 * that way has no closing quote: every input character writes at least one output character, so the output is
 * still longer than `budget` and a cut stays a cut, while a long string of characters that escape to six is never
 * escaped whole only to be cut afterwards.
 */
export function jsonString(text: string, budget = Number.POSITIVE_INFINITY): string {
  const limit = Math.min(text.length, Math.max(0, budget + 1));
  let out = '"';
  let run = 0;
  let index = 0;
  for (; index < limit; index += 1) {
    const code = text.charCodeAt(index);
    let escape: string | undefined;
    if (code === 0x22) escape = '\\"';
    else if (code === 0x5c) escape = "\\\\";
    else if (code < 0x20) escape = NAMED_CONTROL[code] ?? unicodeEscape(code);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      escape = unicodeEscape(code);
    } else if (code >= 0xdc00 && code <= 0xdfff) escape = unicodeEscape(code);
    if (escape !== undefined) {
      out += `${text.slice(run, index)}${escape}`;
      run = index + 1;
    }
  }
  return `${out}${text.slice(run, index)}${index < text.length ? "" : '"'}`;
}

/** One scalar as JSON text; a string or bytes value is written only as far as `budget` needs (as `jsonString`). */
export function scalarJson(value: unknown, budget = Number.POSITIVE_INFINITY): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : jsonString(String(value));
  if (typeof value === "bigint") return jsonString(value.toString(), budget);
  if (typeof value === "string") return jsonString(value, budget);
  if (value instanceof Uint8Array) {
    // Two hex digits per byte and nothing to escape: one byte past half the budget already writes past it, and a
    // literal cut that way has no closing quote, as in `jsonString`.
    const kept = Math.min(value.length, Math.max(0, Math.floor(budget / 2) + 1));
    return `"${Array.from(value.subarray(0, kept), hex2).join("")}${kept < value.length ? "" : '"'}`;
  }
  if (value instanceof Date) return jsonString(dateText(value));
  return jsonString(String(value), budget);
}

const isContainer = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !(value instanceof Uint8Array) && !(value instanceof Date);

interface Frame {
  readonly close: "]" | "}";
  readonly keys: readonly string[] | null;
  readonly source: object;
  index: number;
}

/**
 * JSON text of a nested value, written iteratively with an explicit stack: bigints as digit strings, bytes as a hex
 * string, a Date without Z, keys from Object.keys written as JSON strings (so `__proto__` is a key). Stops as soon as
 * more than `cellChars` characters are written (then cut), and writes `...` for a container nested deeper than
 * `maxDepth` (also counted as cut). The cell bound applies before the work, not after: each key or string value is
 * escaped only as far as the characters left in the cell need.
 */
export function serializeBounded(
  value: unknown,
  cellChars: number,
  maxDepth: number,
): { readonly text: string; readonly cut: boolean } {
  const pieces: string[] = [];
  const stack: Frame[] = [];
  let length = 0;
  let deep = false;
  const write = (piece: string): void => {
    pieces.push(piece);
    length += piece.length;
  };
  const writeValue = (item: unknown): void => {
    if (!isContainer(item)) {
      write(scalarJson(item, cellChars - length));
    } else if (stack.length >= maxDepth) {
      write("...");
      deep = true;
    } else if (Array.isArray(item)) {
      write("[");
      stack.push({ close: "]", keys: null, source: item, index: 0 });
    } else {
      write("{");
      stack.push({ close: "}", keys: Object.keys(item), source: item, index: 0 });
    }
  };
  writeValue(value);
  while (stack.length > 0) {
    // `write` grows `length`, so the cell bound is checked here rather than in the loop condition.
    if (length > cellChars) break;
    const frame = stack[stack.length - 1];
    const total = frame.keys === null ? (frame.source as readonly unknown[]).length : frame.keys.length;
    if (frame.index >= total) {
      write(frame.close);
      stack.pop();
      continue;
    }
    if (frame.index > 0) write(",");
    if (frame.keys === null) {
      const item = (frame.source as readonly unknown[])[frame.index];
      frame.index += 1;
      writeValue(item);
    } else {
      const key = frame.keys[frame.index];
      frame.index += 1;
      write(`${jsonString(key, cellChars - length)}:`);
      writeValue((frame.source as Readonly<Record<string, unknown>>)[key]);
    }
  }
  const text = pieces.join("");
  if (length > cellChars) return { text: cutText(text, cellChars).text, cut: true };
  return { text, cut: deep };
}

/** One value as a cell, by the cell table. */
export function renderCell(
  value: unknown,
  cellChars: number,
  cellMaxDepth: number = S3_PREVIEW_LIMITS.cellMaxDepth,
): { readonly cell: S3PreviewCell; readonly cut: boolean } {
  if (value === null || value === undefined) return { cell: null, cut: false };
  if (typeof value === "boolean") return { cell: value, cut: false };
  if (typeof value === "number") return { cell: Number.isFinite(value) ? value : String(value), cut: false };
  if (typeof value === "bigint") {
    return { cell: Number.isSafeInteger(Number(value)) ? Number(value) : value.toString(), cut: false };
  }
  if (typeof value === "string") {
    const cut = cutText(value, cellChars);
    return { cell: cut.text, cut: cut.cut };
  }
  if (value instanceof Uint8Array) return bytesCell(value, cellChars);
  if (value instanceof Date) return { cell: dateText(value), cut: false };
  if (typeof value === "object") {
    const serialized = serializeBounded(value, cellChars, cellMaxDepth);
    return { cell: serialized.text, cut: serialized.cut };
  }
  const cut = cutText(String(value), cellChars);
  return { cell: cut.text, cut: cut.cut };
}

/**
 * The columns a result keeps: an explicit list keeps exactly its names in its order, each matched
 * against the final names (so `value (2)` and `(No column name)` are addressable), or is refused naming the first
 * unknown one; without a list, columns past `maxColumns` are dropped with N-COLUMNS.
 */
export function selectColumns(
  names: readonly string[],
  requested: readonly string[] | undefined,
  maxColumns: number,
): { readonly indexes: readonly number[]; readonly notices: readonly string[] } {
  if (requested !== undefined) {
    const position = new Map(names.map((name, index) => [name, index] as const));
    const indexes = requested.map((name) => {
      const at = position.get(name);
      if (at === undefined) throw new QueryError(previewSentence("R-COLUMN", { c: spellName(name) }), S3_TYPE);
      return at;
    });
    return { indexes, notices: [] };
  }
  const kept = Math.min(names.length, maxColumns);
  return {
    indexes: Array.from({ length: kept }, (_, index) => index),
    notices: names.length > maxColumns ? [previewSentence("N-COLUMNS", { cap: maxColumns, n: names.length })] : [],
  };
}

/** Rows read positionally from any format: names already unique, values read only for the columns kept. */
export interface RowSource {
  readonly names: readonly string[];
  /** "text" for every column; "json" to type a column by the JSON kind its shown cells share; or one type per name. */
  readonly typing: "text" | "json" | readonly string[];
  readonly rowCount: number;
  readonly valueAt: (row: number, column: number) => unknown;
  /** Rows the object holds in all, when that is known to be more than `rowCount` (Parquet). */
  readonly available?: number;
}

function jsonKind(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : "json";
}

const cellLength = (cell: S3PreviewCell): number =>
  cell === null ? 0 : typeof cell === "string" ? cell.length : String(cell).length;

/**
 * The shown rows of a source: the column bound first, then at most `maxRows` rows, stopping before the row whose
 * cells would take the summed cell characters past `outputChars` (N-OUTPUT); N-ROWS when more rows were available;
 * N-CELLS counting cut cells.
 */
export function buildRows(
  source: RowSource,
  columns: readonly string[] | undefined,
  maxRows: number,
  limits: S3PreviewLimits,
): { readonly rows: S3PreviewRows; readonly notices: readonly string[] } {
  const selection = selectColumns(source.names, columns, limits.maxColumns);
  const kinds = selection.indexes.map(() => new Set<string>());
  const rows: S3PreviewCell[][] = [];
  let characters = 0;
  let cutCells = 0;
  let stoppedByOutput = false;
  const shown = Math.min(source.rowCount, maxRows);
  for (let row = 0; row < shown; row += 1) {
    const cells: S3PreviewCell[] = [];
    const rowKinds: string[] = [];
    let rowCharacters = 0;
    let rowCut = 0;
    for (const column of selection.indexes) {
      const raw = source.valueAt(row, column);
      rowKinds.push(raw === null || raw === undefined ? "" : jsonKind(raw));
      const rendered = renderCell(raw, limits.cellChars, limits.cellMaxDepth);
      cells.push(rendered.cell);
      rowCharacters += cellLength(rendered.cell);
      if (rendered.cut) rowCut += 1;
    }
    if (characters + rowCharacters > limits.outputChars) {
      stoppedByOutput = true;
      break;
    }
    characters += rowCharacters;
    cutCells += rowCut;
    rowKinds.forEach((kind, position) => {
      if (kind !== "") kinds[position].add(kind);
    });
    rows.push(cells);
  }
  const typeOf = (column: number, position: number): string => {
    if (source.typing === "text") return "text";
    if (source.typing === "json") return kinds[position].size === 1 ? [...kinds[position]][0] : "json";
    return source.typing[column];
  };
  const resultColumns: S3PreviewColumn[] = selection.indexes.map((column, position) => ({
    name: source.names[column],
    type: typeOf(column, position),
  }));
  const notices = [...selection.notices];
  if (stoppedByOutput) notices.push(previewSentence("N-OUTPUT", { r: rows.length, cap: limits.outputChars }));
  else if ((source.available ?? source.rowCount) > rows.length)
    notices.push(previewSentence("N-ROWS", { cap: maxRows }));
  if (cutCells > 0) notices.push(previewSentence("N-CELLS", { k: cutCells, cap: limits.cellChars }));
  return { rows: { columns: resultColumns, rows }, notices };
}
