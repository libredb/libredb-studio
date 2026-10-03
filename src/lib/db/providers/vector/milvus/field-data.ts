/**
 * Milvus's columnar FieldData to cells (vector-family spec 5.5, 5.11). Pure.
 *
 * A column is read by its field name, never its position, because the server reorders `fields_data` on every call
 * (R09 F23), and lazily, one row at a time, so results.ts converts no more rows than its byte budget keeps. Every
 * scalar arm is read; Timestamptz and Geometry from either arm the server fills (R09 F17); nullable values from both
 * `valid_data` layouts, row-dense for scalars and compact for vectors (R09 F15); Int64 as exact decimal strings;
 * a JSON cell and the dynamic field from their raw bytes through `quoteUnsafeIntegers`, so an integer above 2^53
 * stays exact (R09 F16); the dynamic field as its keys in stored order, duplicates included, which `JSON.parse`
 * alone would reorder and merge (R40 M19).
 */
import { QueryError } from "@/lib/db/errors";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { QueryWarning } from "@/lib/types";
import type { WireFieldData, WireScalarField, WireVectorField } from "./client";
import { binaryRow, bfloat16Row, float16Row, indexMapFromSparse, int8Row, sparseFromRow } from "./codec";
import { unsupportedDataTypeError } from "./errors";
import { shortestFloat32 } from "./float32-text";
import { UNDECODED_TYPES } from "./milvus-vocabulary";
import { MILVUS_BOUNDS } from "./routes";

const PROVIDER = "milvus" as const;

/** What decoding noticed, for the result's warnings. */
export class DecodeNotes {
  cutCells = 0;
  readonly unsafeIntegerColumns = new Set<string>();
  readonly undecodedColumns = new Map<string, string>();
  readonly undecodedCells = new Map<string, number>();
  readonly nonFiniteCells = new Map<string, number>();

  count(map: Map<string, number>, column: string): void {
    map.set(column, (map.get(column) ?? 0) + 1);
  }

  warnings(): QueryWarning[] {
    const warnings: QueryWarning[] = [];
    if (this.cutCells > 0) {
      warnings.push({
        message: `${this.cutCells} text cells were longer than 65,536 characters and are cut, with a marker; Copy and the detail view carry the cut text.`,
      });
    }
    if (this.unsafeIntegerColumns.size > 0) {
      warnings.push({
        message: `Integers above 2^53 in ${[...this.unsafeIntegerColumns].join(", ")} are shown as exact digit strings, because a JavaScript number would round them.`,
      });
    }
    for (const [column, type] of this.undecodedColumns) {
      warnings.push({
        message: `Column ${column} is of type ${type}, which Studio does not decode; its cells are empty.`,
      });
    }
    for (const [column, cells] of this.undecodedCells) {
      warnings.push({ message: `${cells} cells of ${column} are in a form Studio does not decode and are empty.` });
    }
    for (const [column, cells] of this.nonFiniteCells) {
      warnings.push({ message: `${cells} cells of ${column} are not finite numbers and are shown as words.` });
    }
    return warnings;
  }
}

/** The text of a cut cell: never inside a surrogate pair, with a visible marker (5.6, R51 U39). */
export function cutString(text: string, notes: DecodeNotes): string {
  const limit = MILVUS_BOUNDS.stringCellUnits;
  if (text.length <= limit) return text;
  const high = text.charCodeAt(limit - 1);
  const end = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
  notes.cutCells += 1;
  return `${text.slice(0, end)}…[cut: ${end} of ${text.length} characters shown]`;
}

// -- the lossless reading of a dynamic field ---------------------------------------------------------------------

/** One row's dynamic keys in stored order, a repeated key once with its last value (R40 M19). */
export interface DynamicCell {
  readonly entries: readonly (readonly [string, unknown])[];
  readonly duplicates: readonly string[];
}

function skipSpace(text: string, index: number): number {
  let at = index;
  while (at < text.length && " \t\n\r".includes(text[at])) at += 1;
  return at;
}

function endOfString(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
  return at + 1;
}

/** The end of the JSON value at `start`: a string, a bracketed value (strings skipped inside) or a scalar. */
function endOfValue(text: string, start: number): number {
  if (text[start] === '"') return endOfString(text, start);
  if (text[start] !== "{" && text[start] !== "[") {
    let at = start;
    while (at < text.length && !",}] \t\n\r".includes(text[at])) at += 1;
    return at;
  }
  let depth = 0;
  let at = start;
  do {
    if (text[at] === '"') {
      at = endOfString(text, at);
      continue;
    }
    if (text[at] === "{" || text[at] === "[") depth += 1;
    if (text[at] === "}" || text[at] === "]") depth -= 1;
    at += 1;
  } while (depth > 0 && at < text.length);
  return at;
}

function parseJsonValue(text: string, column: string, notes: DecodeNotes): unknown {
  const quoted = quoteUnsafeIntegers(text);
  if (quoted !== text) notes.unsafeIntegerColumns.add(column);
  return JSON.parse(quoted);
}

function malformedDynamic(): QueryError {
  return new QueryError("Milvus returned a dynamic field that is not a JSON object.", PROVIDER);
}

/** A dynamic field's raw text, read key by key in stored order. */
export function dynamicEntries(text: string, notes: DecodeNotes): DynamicCell {
  const entries: [string, unknown][] = [];
  const duplicates: string[] = [];
  const positions = new Map<string, number>();
  let at = skipSpace(text, 0);
  if (text[at] !== "{") throw malformedDynamic();
  at = skipSpace(text, at + 1);
  while (text[at] !== "}") {
    if (text[at] !== '"') throw malformedDynamic();
    const keyEnd = endOfString(text, at);
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipSpace(text, keyEnd);
    if (text[at] !== ":") throw malformedDynamic();
    const valueStart = skipSpace(text, at + 1);
    const valueEnd = endOfValue(text, valueStart);
    const value = parseJsonValue(text.slice(valueStart, valueEnd), `$meta.${key}`, notes);
    const seen = positions.get(key);
    if (seen === undefined) {
      positions.set(key, entries.length);
      entries.push([key, value]);
    } else {
      entries[seen] = [key, value];
      if (!duplicates.includes(key)) duplicates.push(key);
    }
    at = skipSpace(text, valueEnd);
    if (text[at] === ",") at = skipSpace(text, at + 1);
    else if (text[at] !== "}") throw malformedDynamic();
  }
  return { entries, duplicates };
}

// -- Geometry and Timestamptz ------------------------------------------------------------------------------------

const WKB_NAMES = [
  "",
  "POINT",
  "LINESTRING",
  "POLYGON",
  "MULTIPOINT",
  "MULTILINESTRING",
  "MULTIPOLYGON",
  "GEOMETRYCOLLECTION",
];

/** Well-known binary, two-dimensional, to well-known text; undefined for a form Studio does not decode. */
export function wkbToWkt(bytes: Uint8Array): string | undefined {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const point = (little: boolean) => {
    const x = data.getFloat64(at, little);
    const y = data.getFloat64(at + 8, little);
    at += 16;
    return `${x} ${y}`;
  };
  const points = (little: boolean) => {
    const count = data.getUint32(at, little);
    at += 4;
    return Array.from({ length: count }, () => point(little));
  };
  const geometry = (): { readonly name: string; readonly body: string } | undefined => {
    const little = data.getUint8(at) === 1;
    const type = data.getUint32(at + 1, little);
    at += 5;
    const name = WKB_NAMES[type];
    if (name === undefined || name === "") return undefined;
    if (type === 1) {
      const text = point(little);
      return { name, body: text === "NaN NaN" ? "EMPTY" : `(${text})` };
    }
    if (type === 2) return { name, body: wrap(points(little)) };
    if (type === 3) {
      const rings = data.getUint32(at, little);
      at += 4;
      return { name, body: wrap(Array.from({ length: rings }, () => wrap(points(little)))) };
    }
    const count = data.getUint32(at, little);
    at += 4;
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const part = geometry();
      if (part === undefined) return undefined;
      parts.push(type === 7 ? `${part.name} ${part.body}` : part.body);
    }
    return { name, body: wrap(parts) };
  };
  try {
    const result = geometry();
    return result === undefined || at !== bytes.byteLength ? undefined : `${result.name} ${result.body}`;
  } catch {
    // A truncated WKB reads past the end of its bytes: a form Studio does not decode, reported by the caller.
    return undefined;
  }
}

function wrap(parts: readonly string[]): string {
  return parts.length === 0 ? "EMPTY" : `(${parts.join(", ")})`;
}

const MAX_DATE_MS = 8.64e15;

/** A Timestamptz in microseconds since the Unix epoch, as ISO text with its microseconds; undefined out of range. */
export function isoFromMicros(text: string): string | undefined {
  const micros = BigInt(text);
  let millis = micros / BigInt(1000);
  let rest = micros % BigInt(1000);
  if (rest < BigInt(0)) {
    millis -= BigInt(1);
    rest += BigInt(1000);
  }
  if (Math.abs(Number(millis)) > MAX_DATE_MS) return undefined;
  const iso = new Date(Number(millis)).toISOString();
  return rest === BigInt(0) ? iso : iso.replace("Z", `${String(rest).padStart(3, "0")}Z`);
}

// -- columns -----------------------------------------------------------------------------------------------------

/** One column of an answer, read one row at a time. */
export interface ColumnReader {
  readonly name: string;
  readonly type: string;
  readonly isDynamic: boolean;
  readonly length: number;
  cell(row: number): unknown;
}

function malformed(column: string, detail: string): QueryError {
  return new QueryError(`Milvus returned column ${column} in a shape Studio cannot read: ${detail}.`, PROVIDER);
}

/** For each row, the position of its value, or -1 for a null, from either valid_data layout (R09 F15). */
function valuePositions(column: string, values: number, valid: readonly boolean[]): Int32Array | undefined {
  if (valid.length === 0) return undefined;
  const positions = new Int32Array(valid.length);
  const dense = values === valid.length;
  const present = valid.filter(Boolean).length;
  if (!dense && values !== present) throw malformed(column, `${values} values for ${valid.length} rows`);
  let next = 0;
  valid.forEach((isValid, row) => {
    positions[row] = !isValid ? -1 : dense ? row : next;
    if (isValid) next += 1;
  });
  return positions;
}

function finiteOrWord(value: number, column: string, notes: DecodeNotes): number | string {
  if (Number.isFinite(value)) return value;
  notes.count(notes.nonFiniteCells, column);
  return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A column's values before nulls: how many, and the cell of each, decoded when asked. */
interface CellSource {
  readonly count: number;
  at(index: number): unknown;
}

/** The values of a scalar arm, with an element reader for each; `type` picks between the arms a type may use. */
function scalarArm(scalars: WireScalarField, type: string, column: string, notes: DecodeNotes): CellSource {
  const arm = scalars.data ?? "";
  const read = <T>(values: readonly T[] | undefined, map: (value: T) => unknown): CellSource => ({
    count: values?.length ?? 0,
    at: (index: number) => map((values ?? [])[index]),
  });
  switch (arm) {
    case "bool_data":
      return read(scalars.bool_data?.data, (value) => value);
    case "int_data":
      return read(scalars.int_data?.data, (value) => value);
    case "long_data":
      return read(scalars.long_data?.data, (value) => value);
    case "float_data":
      return read(scalars.float_data?.data, (value) => finiteOrWord(shortestFloat32(value), column, notes));
    case "double_data":
      return read(scalars.double_data?.data, (value) => finiteOrWord(value, column, notes));
    case "string_data":
      return read(scalars.string_data?.data, (value) => (type === "Timestamptz" ? value : cutString(value, notes)));
    case "geometry_wkt_data":
      return read(scalars.geometry_wkt_data?.data, (value) => value);
    case "json_data":
      return read(scalars.json_data?.data, (value) =>
        value.length === 0 ? null : parseJsonValue(textOf(value), column, notes),
      );
    case "timestamptz_data":
      return read(scalars.timestamptz_data?.data, (value) => {
        const iso = isoFromMicros(value);
        if (iso === undefined) notes.count(notes.undecodedCells, column);
        return iso ?? null;
      });
    case "geometry_data":
      return read(scalars.geometry_data?.data, (value) => {
        const wkt = wkbToWkt(value);
        if (wkt === undefined) notes.count(notes.undecodedCells, column);
        return wkt ?? null;
      });
    case "array_data":
      return read(scalars.array_data?.data, (element) => {
        const inner = scalarArm(element, scalars.array_data?.element_type ?? "", column, notes);
        return Array.from({ length: inner.count }, (_, index) => inner.at(index));
      });
    default:
      throw malformed(column, `the scalar arm ${arm || "none"} for ${type}`);
  }
}

/** How many rows of `width` units `units` holds; NaN when it is not a whole number, which readColumn refuses. */
function wholeRows(units: number, width: number): number {
  if (width === 0) return units === 0 ? 0 : Number.NaN;
  return units / width;
}

/** The rows of a vector column, from the arm its type fills. */
function vectorArm(vectors: WireVectorField, type: string): CellSource {
  const dimension = Number(vectors.dim);
  switch (type) {
    case "FloatVector": {
      const data = vectors.float_vector?.data ?? [];
      return {
        count: wholeRows(data.length, dimension),
        at: (row: number) => data.slice(row * dimension, (row + 1) * dimension).map(shortestFloat32),
      };
    }
    case "Float16Vector":
      return {
        count: wholeRows(vectors.float16_vector.length, 2 * dimension),
        at: (row: number) => float16Row(vectors.float16_vector, dimension, row),
      };
    case "BFloat16Vector":
      return {
        count: wholeRows(vectors.bfloat16_vector.length, 2 * dimension),
        at: (row: number) => bfloat16Row(vectors.bfloat16_vector, dimension, row),
      };
    case "Int8Vector":
      return {
        count: wholeRows(vectors.int8_vector.length, dimension),
        at: (row: number) => int8Row(vectors.int8_vector, dimension, row),
      };
    case "BinaryVector":
      return {
        count: wholeRows(vectors.binary_vector.length, dimension / 8),
        at: (row: number) => binaryRow(vectors.binary_vector, dimension, row),
      };
    case "SparseFloatVector": {
      const rows = vectors.sparse_float_vector?.contents ?? [];
      return { count: rows.length, at: (row: number) => indexMapFromSparse(sparseFromRow(rows[row])) };
    }
    default: {
      // ArrayOfVector: one VectorField of its element type per row.
      const lists = vectors.vector_array?.data ?? [];
      const element = vectors.vector_array?.element_type ?? "";
      return {
        count: lists.length,
        at: (row: number) => {
          const inner = vectorArm(lists[row], element);
          return Array.from({ length: inner.count }, (_, index) => inner.at(index));
        },
      };
    }
  }
}

/** Every column of a struct array, zipped into one array of element objects per row (R09 F18). */
function structArm(fd: WireFieldData, notes: DecodeNotes): CellSource {
  const columns = (fd.struct_arrays?.fields ?? []).map((field) => readColumn(field, notes));
  return {
    count: columns.length === 0 ? 0 : columns[0].length,
    at: (row: number) => {
      const cells = columns.map((column) => column.cell(row) as readonly unknown[] | null);
      const size = cells[0]?.length ?? 0;
      return Array.from({ length: size }, (_, element) => {
        const object: Record<string, unknown> = Object.create(null);
        columns.forEach((column, index) => {
          object[column.name] = cells[index]?.[element] ?? null;
        });
        return object;
      });
    },
  };
}

/** Every DataType this reader knows; anything else is "unsupported type N", never guessed (E20). */
const KNOWN_TYPES: readonly string[] = [
  "Bool",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Float",
  "Double",
  "String",
  "VarChar",
  "Text",
  "JSON",
  "Array",
  "Timestamptz",
  "Geometry",
  "FloatVector",
  "Float16Vector",
  "BFloat16Vector",
  "Int8Vector",
  "BinaryVector",
  "SparseFloatVector",
  "ArrayOfVector",
  "ArrayOfStruct",
];

/** The number of values in whichever scalar arm is set. */
function armLength(scalars: WireScalarField | null): number {
  const arm = scalars?.data;
  if (scalars === null || arm === undefined) return 0;
  const set = (scalars as unknown as Record<string, { readonly data?: readonly unknown[] } | null>)[arm];
  return set?.data?.length ?? 0;
}

/** One FieldData column as a lazy reader of its cells. */
export function readColumn(fd: WireFieldData, notes: DecodeNotes): ColumnReader {
  const column = fd.is_dynamic ? "$meta" : fd.field_name;
  let source: CellSource;
  if (UNDECODED_TYPES.includes(fd.type)) {
    notes.undecodedColumns.set(column, fd.type);
    source = { count: armLength(fd.scalars), at: () => null };
  } else if (!KNOWN_TYPES.includes(fd.type)) {
    throw unsupportedDataTypeError(fd.type);
  } else if (fd.type === "ArrayOfStruct") {
    source = structArm(fd, notes);
  } else if (fd.field === "vectors" && fd.vectors !== null) {
    source = vectorArm(fd.vectors, fd.type);
  } else if (fd.field === "scalars" && fd.scalars !== null && fd.is_dynamic) {
    const raw = fd.scalars.json_data?.data ?? [];
    source = {
      count: raw.length,
      at: (index) => (raw[index].length === 0 ? null : dynamicEntries(textOf(raw[index]), notes)),
    };
  } else if (fd.field === "scalars" && fd.scalars !== null) {
    source = scalarArm(fd.scalars, fd.type, column, notes);
  } else {
    throw malformed(column, `no data for ${fd.type}`);
  }
  if (!Number.isInteger(source.count)) throw malformed(column, "a vector length that is not whole rows");
  const positions = valuePositions(column, source.count, fd.valid_data);
  return {
    name: fd.field_name,
    type: fd.type,
    isDynamic: fd.is_dynamic,
    length: positions === undefined ? source.count : positions.length,
    cell: (row) => {
      const index = positions === undefined ? row : positions[row];
      return index === -1 ? null : source.at(index);
    },
  };
}
