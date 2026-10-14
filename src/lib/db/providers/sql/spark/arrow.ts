/**
 * The only module under src/ that imports apache-arrow: one Arrow IPC stream to raw columns. The stock
 * getters are never used for int64, decimal, timestamp, time, duration or interval values, which they return as
 * bigint, unscaled digits, rounded milliseconds or raw words; the Studio value mapper (values.ts) reads the raw
 * buffers instead. Every stream passes checkIpcStream first, so apache-arrow never reads an unchecked byte, and a
 * row's decoded cost is read from offsets and children's lengths before any value is built. Pure: no I/O,
 * no logger.
 */
import {
  type Data,
  type DataType,
  DateUnit,
  type Field,
  IntervalUnit,
  Precision,
  type Table,
  TimeUnit,
  tableFromIPC,
  Type,
} from "apache-arrow";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import { checkIpcStream, SPARK_IPC_FAILURES } from "./ipc-guard";

/** The Arrow types the value mapper reads, the only ones a column can carry. */
export type ArrowTypeName =
  | "null"
  | "bool"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "decimal128"
  | "utf8"
  | "binary"
  | "date32"
  | "timestamp"
  | "time64"
  | "interval-year-month"
  | "interval-month-day-nano"
  | "duration"
  | "list"
  | "map"
  | "struct";

/** One column, or one child of a nested column: its Arrow field and its raw buffers, as the stream holds them. */
export interface ArrowColumnData {
  readonly name: string;
  readonly type: ArrowTypeName;
  readonly length: number;
  /** A Null column's every value is null, so its null count is its length. */
  readonly nullCount: number;
  /** The validity bitmap, one bit a value; undefined when the null count is 0 and on a Null column. */
  readonly validity: Uint8Array | undefined;
  /**
   * A byte view of the values buffer (bit-packed for Bool), no copy; undefined on Null, List, Map and Struct, and on a
   * column of no rows it may be undefined, since apache-arrow may hold no buffer for one. A column with rows always has
   * one, empty when every string or binary value is.
   */
  readonly values: Uint8Array | undefined;
  /**
   * The 32-bit offsets of Utf8, Binary, List and Map, a view of the first length + 1 of them (a writer may pad the
   * buffer past them, and a column of no values may carry none); undefined on every other type.
   */
  readonly offsets: Int32Array | undefined;
  /** A List's element, a Map's entries struct of key and value, a Struct's fields; empty on every other type. */
  readonly children: readonly ArrowColumnData[];
  /** Decimal128 only. */
  readonly precision?: number;
  /** Decimal128 only. */
  readonly scale?: number;
  /** Timestamp only: the zone the field names, or null for a timestamp without one. */
  readonly timezone?: string | null;
  readonly metadata: ReadonlyMap<string, string>;
}

export interface ArrowColumns {
  readonly rowCount: number;
  readonly columns: readonly ArrowColumnData[];
}

const INT_NAMES: Readonly<Record<number, ArrowTypeName>> = { 8: "int8", 16: "int16", 32: "int32", 64: "int64" };
const INTERVAL_NAMES: Readonly<Record<number, ArrowTypeName>> = {
  [IntervalUnit.YEAR_MONTH]: "interval-year-month",
  [IntervalUnit.MONTH_DAY_NANO]: "interval-month-day-nano",
};

function unreadable(what: string, cause?: unknown): never {
  throw new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(what), { cause });
}

/**
 * The mapped type, read from apache-arrow's field type. The pre-check already refused every other type, so a
 * type left unnamed here is refused with the pre-check's own words.
 */
function typeName(type: DataType): ArrowTypeName {
  const t = type as DataType & { bitWidth?: number; isSigned?: boolean; precision?: number; unit?: number };
  let name: ArrowTypeName | undefined;
  switch (type.typeId) {
    case Type.Null:
      name = "null";
      break;
    case Type.Bool:
      name = "bool";
      break;
    case Type.Int:
      name = t.isSigned ? INT_NAMES[t.bitWidth ?? 0] : undefined;
      break;
    case Type.Float:
      name = t.precision === Precision.SINGLE ? "float32" : t.precision === Precision.DOUBLE ? "float64" : undefined;
      break;
    case Type.Decimal:
      name = t.bitWidth === 128 ? "decimal128" : undefined;
      break;
    case Type.Utf8:
      name = "utf8";
      break;
    case Type.Binary:
      name = "binary";
      break;
    case Type.Date:
      name = t.unit === DateUnit.DAY ? "date32" : undefined;
      break;
    case Type.Timestamp:
      name = t.unit === TimeUnit.MICROSECOND ? "timestamp" : undefined;
      break;
    case Type.Time:
      name = t.unit === TimeUnit.NANOSECOND && t.bitWidth === 64 ? "time64" : undefined;
      break;
    case Type.Interval:
      name = INTERVAL_NAMES[t.unit ?? -1];
      break;
    case Type.Duration:
      name = t.unit === TimeUnit.MICROSECOND ? "duration" : undefined;
      break;
    case Type.List:
      name = "list";
      break;
    case Type.Map:
      name = "map";
      break;
    case Type.Struct:
      name = "struct";
      break;
  }
  if (name === undefined) unreadable(SPARK_IPC_FAILURES.type);
  return name;
}

/** A view of a typed array's bytes, no copy; undefined for an absent buffer (apache-arrow's fresh empty array). */
function bytesOf(array: ArrayBufferView | undefined): Uint8Array | undefined {
  return array === undefined || (array.byteLength === 0 && array.byteOffset === 0 && array.buffer.byteLength === 0)
    ? undefined
    : new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function columnOf(field: Field, data: Data | undefined): ArrowColumnData {
  const type = typeName(field.type);
  const t = field.type as DataType & { precision?: number; scale?: number; timezone?: string | null };
  const nullCount = data?.nullCount ?? 0;
  const children = (field.type.children ?? []) as Field[];
  return {
    name: field.name,
    type,
    length: data?.length ?? 0,
    nullCount,
    validity: nullCount > 0 ? data?.nullBitmap : undefined,
    values:
      type === "null" || type === "list" || type === "map" || type === "struct" ? undefined : bytesOf(data?.values),
    offsets: data?.valueOffsets instanceof Int32Array ? data.valueOffsets.subarray(0, data.length + 1) : undefined,
    children: children.map((child, index) => columnOf(child, data?.children[index])),
    ...(type === "decimal128" ? { precision: t.precision, scale: t.scale } : {}),
    ...(type === "timestamp" ? { timezone: t.timezone ?? null } : {}),
    // Arrow's Schema.fbs makes a metadata value optional: apache-arrow reads an absent one as null, and Arrow's
    // reference reader as the empty string, as Studio does.
    metadata: new Map(Array.from(field.metadata, ([key, value]) => [key, value ?? ""])),
  };
}

/** One checked Arrow IPC stream to its columns' fields and raw buffers; refuses with `SparkError("unreadable")`. */
export function readIpcColumns(bytes: Uint8Array): ArrowColumns {
  // Spark sends one record batch a stream. The pre-check counts them, so a second one is refused before
  // apache-arrow reads any of the stream.
  if (checkIpcStream(bytes).batches > 1) unreadable("a stream with more than one record batch");
  let table: Table;
  try {
    table = tableFromIPC(bytes);
  } catch (error) {
    // The pre-check passed and apache-arrow still could not read it: the stream is refused, never shown, and the
    // reader's own error is kept as the refusal's cause.
    unreadable("a stream the Arrow reader could not read", error);
  }
  // A stream of no batch reads as one empty batch of the schema's columns, so it answers zero rows.
  const batch = table.batches[0];
  return {
    rowCount: batch?.numRows ?? 0,
    columns: table.schema.fields.map((field, index) => columnOf(field, batch?.data.children[index])),
  };
}

/**
 * The cost of rows [from, to) of a column: 8 bytes a value at every depth plus string and binary lengths.
 * An empty range reads no offset, since a column of no values may carry none.
 */
function rangeCost(column: ArrowColumnData, from: number, to: number): number {
  if (from === to) return 0;
  let cost = 8 * (to - from);
  if (column.offsets !== undefined && (column.type === "utf8" || column.type === "binary")) {
    cost += column.offsets[to] - column.offsets[from];
  } else if (column.offsets !== undefined) {
    cost += rangeCost(column.children[0], column.offsets[from], column.offsets[to]);
  } else if (column.type === "struct") {
    for (const child of column.children) cost += rangeCost(child, from, to);
  }
  return cost;
}

/**
 * The decoded cost of one row, from offsets and children's lengths before any value is built. A nested
 * range is summed in one step per level, never per element, so a list over a long Null child costs no loop. The
 * offsets read are the ones the pre-check bounded, so no read falls outside them; a row outside the batch is refused.
 */
export function rowCost(columns: ArrowColumns, row: number): number {
  if (!Number.isInteger(row) || row < 0 || row >= columns.rowCount) {
    throw new RangeError(`row ${row} is not one of the batch's ${columns.rowCount} rows`);
  }
  let cost = 0;
  for (const column of columns.columns) cost += rangeCost(column, row, row + 1);
  return cost;
}
