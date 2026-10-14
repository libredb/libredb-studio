/**
 * Arrow IPC streams for the Spark provider's decoder tests, written with apache-arrow 21.2.0 (the version the provider
 * pins) or by hand. One of the two test files that import apache-arrow, with
 * tests/unit/db/spark/arrow-reader-failure.test.ts, as the ARROW_IMPORTERS list of
 * tests/unit/db/spark/pure-seam-guard.test.ts holds. No bun:test import and no Bun global, so the Node child of tests/unit/db/spark/grpc-runtimes.test.ts loads
 * it too.
 */
import {
  Binary,
  Bool,
  type Data,
  type DataType,
  DateDay,
  DateMillisecond,
  Decimal,
  DurationMicrosecond,
  Field,
  Float16,
  Float32,
  Float64,
  Int16,
  Int32,
  Int64,
  Int8,
  IntervalMonthDayNano,
  IntervalYearMonth,
  LargeBinary,
  LargeUtf8,
  List,
  makeData,
  Map_,
  Null,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableFromArrays,
  tableToIPC,
  TimeNanosecond,
  TimestampMicrosecond,
  TimestampMillisecond,
  Uint8,
  Utf8,
} from "apache-arrow";

/** One fixed-width kind: its Arrow type, its width in bytes and how a value is written. */
type FixedKind =
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "date32"
  | "timestamp-utc"
  | "timestamp-ntz"
  | "time64-ns"
  | "duration-us"
  | "interval-ym"
  | "uint8"
  | "float16"
  | "date64"
  | "timestamp-ms";

/** A column of the stream: its Arrow type and raw content, nested kinds built from their children. */
export type SparkIpcColumn = { readonly name: string; readonly metadata?: Readonly<Record<string, string>> } & (
  | { readonly kind: "null"; readonly length: number }
  | { readonly kind: "bool"; readonly values: readonly (boolean | null)[] }
  | { readonly kind: FixedKind; readonly values: readonly (number | bigint | null)[] }
  | {
      readonly kind: "decimal";
      readonly precision: number;
      readonly scale: number;
      readonly values: readonly (bigint | null)[];
    }
  | {
      readonly kind: "interval-mdn";
      readonly values: readonly ({ readonly months: number; readonly days: number; readonly nanos: bigint } | null)[];
    }
  | { readonly kind: "utf8" | "large-utf8"; readonly values: readonly (string | null)[] }
  | { readonly kind: "binary" | "large-binary"; readonly values: readonly (Uint8Array | null)[] }
  | {
      readonly kind: "list";
      readonly offsets: readonly number[];
      readonly valid?: readonly boolean[];
      readonly child: SparkIpcColumn;
    }
  | {
      readonly kind: "map";
      readonly offsets: readonly number[];
      readonly valid?: readonly boolean[];
      readonly keys: SparkIpcColumn;
      readonly items: SparkIpcColumn;
    }
  | {
      readonly kind: "struct";
      readonly length: number;
      readonly valid?: readonly boolean[];
      readonly children: readonly SparkIpcColumn[];
    }
);

const FIXED: Readonly<
  Record<
    FixedKind,
    {
      readonly type: () => DataType;
      readonly width: number;
      readonly write: (view: DataView, at: number, value: number | bigint) => void;
    }
  >
> = {
  int8: { type: () => new Int8(), width: 1, write: (v, at, x) => v.setInt8(at, Number(x)) },
  int16: { type: () => new Int16(), width: 2, write: (v, at, x) => v.setInt16(at, Number(x), true) },
  int32: { type: () => new Int32(), width: 4, write: (v, at, x) => v.setInt32(at, Number(x), true) },
  int64: { type: () => new Int64(), width: 8, write: (v, at, x) => v.setBigInt64(at, BigInt(x), true) },
  float32: { type: () => new Float32(), width: 4, write: (v, at, x) => v.setFloat32(at, Number(x), true) },
  float64: { type: () => new Float64(), width: 8, write: (v, at, x) => v.setFloat64(at, Number(x), true) },
  date32: { type: () => new DateDay(), width: 4, write: (v, at, x) => v.setInt32(at, Number(x), true) },
  "timestamp-utc": {
    type: () => new TimestampMicrosecond("UTC"),
    width: 8,
    write: (v, at, x) => v.setBigInt64(at, BigInt(x), true),
  },
  "timestamp-ntz": {
    type: () => new TimestampMicrosecond(),
    width: 8,
    write: (v, at, x) => v.setBigInt64(at, BigInt(x), true),
  },
  "time64-ns": { type: () => new TimeNanosecond(), width: 8, write: (v, at, x) => v.setBigInt64(at, BigInt(x), true) },
  "duration-us": {
    type: () => new DurationMicrosecond(),
    width: 8,
    write: (v, at, x) => v.setBigInt64(at, BigInt(x), true),
  },
  "interval-ym": {
    type: () => new IntervalYearMonth(),
    width: 4,
    write: (v, at, x) => v.setInt32(at, Number(x), true),
  },
  uint8: { type: () => new Uint8(), width: 1, write: (v, at, x) => v.setUint8(at, Number(x)) },
  float16: { type: () => new Float16(), width: 2, write: (v, at, x) => v.setUint16(at, Number(x), true) },
  date64: { type: () => new DateMillisecond(), width: 8, write: (v, at, x) => v.setBigInt64(at, BigInt(x), true) },
  "timestamp-ms": {
    type: () => new TimestampMillisecond(),
    width: 8,
    write: (v, at, x) => v.setBigInt64(at, BigInt(x), true),
  },
};

/** A validity bitmap, one bit a row, or undefined when every row is valid. */
function bitmap(valid: readonly boolean[]): Uint8Array | undefined {
  if (valid.every(Boolean)) return undefined;
  const bits = new Uint8Array(Math.ceil(valid.length / 8));
  valid.forEach((ok, row) => {
    if (ok) bits[row >> 3] |= 1 << (row & 7);
  });
  return bits;
}

function validityOf(column: SparkIpcColumn): readonly boolean[] {
  if ("values" in column) return column.values.map((value) => value !== null);
  if (column.kind === "list" || column.kind === "map") return column.valid ?? column.offsets.slice(1).map(() => true);
  if (column.kind === "struct") return column.valid ?? Array.from({ length: column.length }, () => true);
  return Array.from({ length: column.length }, () => true);
}

function typeOf(column: SparkIpcColumn): DataType {
  switch (column.kind) {
    case "null":
      return new Null();
    case "bool":
      return new Bool();
    case "decimal":
      return new Decimal(column.scale, column.precision, 128);
    case "interval-mdn":
      return new IntervalMonthDayNano();
    case "utf8":
      return new Utf8();
    case "large-utf8":
      return new LargeUtf8();
    case "binary":
      return new Binary();
    case "large-binary":
      return new LargeBinary();
    case "list":
      return new List(fieldOf(column.child));
    case "map":
      return new Map_<DataType, DataType>(
        new Field("entries", new Struct([fieldOf(column.keys), fieldOf(column.items)]), false),
      );
    case "struct":
      return new Struct(column.children.map(fieldOf));
    default:
      return FIXED[column.kind].type();
  }
}

function fieldOf(column: SparkIpcColumn): Field {
  return new Field(column.name, typeOf(column), true, new Map(Object.entries(column.metadata ?? {})));
}

function bytesOf(values: readonly (string | Uint8Array | null)[]): { offsets: Int32Array; data: Uint8Array } {
  const parts = values.map((value) =>
    value === null ? new Uint8Array(0) : typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  const offsets = new Int32Array(parts.length + 1);
  parts.forEach((part, index) => {
    offsets[index + 1] = offsets[index] + part.byteLength;
  });
  const data = new Uint8Array(offsets[parts.length]);
  parts.forEach((part, index) => data.set(part, offsets[index]));
  return { offsets, data };
}

function dataOf(column: SparkIpcColumn): Data {
  const type = typeOf(column);
  const valid = validityOf(column);
  const base = { type, length: valid.length, nullCount: valid.filter((ok) => !ok).length, nullBitmap: bitmap(valid) };
  switch (column.kind) {
    case "null":
      return makeData({ type: new Null(), length: column.length });
    case "bool": {
      const bits = new Uint8Array(Math.ceil(column.values.length / 8));
      column.values.forEach((value, row) => {
        if (value === true) bits[row >> 3] |= 1 << (row & 7);
      });
      return makeData({ ...base, type: new Bool(), data: bits });
    }
    case "decimal": {
      const raw = new DataView(new ArrayBuffer(16 * column.values.length));
      column.values.forEach((value, row) => {
        const word = BigInt.asUintN(128, value ?? BigInt(0));
        raw.setBigUint64(16 * row, BigInt.asUintN(64, word), true);
        raw.setBigUint64(16 * row + 8, word >> BigInt(64), true);
      });
      return makeData({ ...base, type: type as Decimal, data: new Uint32Array(raw.buffer) });
    }
    case "interval-mdn": {
      const raw = new DataView(new ArrayBuffer(16 * column.values.length));
      column.values.forEach((value, row) => {
        raw.setInt32(16 * row, value?.months ?? 0, true);
        raw.setInt32(16 * row + 4, value?.days ?? 0, true);
        raw.setBigInt64(16 * row + 8, value?.nanos ?? BigInt(0), true);
      });
      return makeData({ ...base, type: type as IntervalMonthDayNano, data: new Int32Array(raw.buffer) });
    }
    case "utf8":
    case "binary": {
      const { offsets, data } = bytesOf(column.values);
      return makeData({ ...base, type: type as Utf8, valueOffsets: offsets, data });
    }
    case "large-utf8":
    case "large-binary": {
      const { offsets, data } = bytesOf(column.values);
      return makeData({ ...base, type: type as LargeUtf8, valueOffsets: BigInt64Array.from(offsets, BigInt), data });
    }
    case "list":
      return makeData({
        ...base,
        type: type as List,
        valueOffsets: Int32Array.from(column.offsets),
        child: dataOf(column.child),
      });
    case "map": {
      const entries = makeData({
        type: new Struct([fieldOf(column.keys), fieldOf(column.items)]),
        length: validityOf(column.keys).length,
        nullCount: 0,
        children: [dataOf(column.keys), dataOf(column.items)],
      });
      return makeData({ ...base, type: type as Map_, valueOffsets: Int32Array.from(column.offsets), child: entries });
    }
    case "struct":
      return makeData({ ...base, type: type as Struct, children: column.children.map(dataOf) });
    default: {
      const kind = FIXED[column.kind];
      const raw = new DataView(new ArrayBuffer(kind.width * column.values.length));
      column.values.forEach((value, row) => kind.write(raw, kind.width * row, value ?? 0));
      return makeData({ ...base, data: new Uint8Array(raw.buffer) } as Parameters<typeof makeData>[0]);
    }
  }
}

/** One complete IPC stream of one record batch holding `columns`, every column as long as the first. */
export function columnsStream(columns: readonly SparkIpcColumn[]): Uint8Array {
  const fields = columns.map(fieldOf);
  const children = columns.map(dataOf);
  const length = children.length === 0 ? 0 : children[0].length;
  const batch = new RecordBatch(
    new Schema(fields),
    makeData({ type: new Struct(fields), length, nullCount: 0, children }),
  );
  return tableToIPC(new Table([batch]), "stream");
}

/** One Utf8 column `v` of `rows` values of `width` characters. */
export function stringBatch(rows: number, width: number): Uint8Array {
  return columnsStream([{ name: "v", kind: "utf8", values: Array.from({ length: rows }, () => "x".repeat(width)) }]);
}

/** One Int64 column `id` holding `start` to `start + rows - 1`. */
export function int64Batch(start: number, rows: number): Uint8Array {
  return columnsStream([
    { name: "id", kind: "int64", values: Array.from({ length: rows }, (_, row) => BigInt(start + row)) },
  ]);
}

export function largeUtf8Stream(): Uint8Array {
  return columnsStream([{ name: "v", kind: "large-utf8", values: ["spark"] }]);
}

export function largeBinaryStream(): Uint8Array {
  return columnsStream([{ name: "b", kind: "large-binary", values: [new Uint8Array([1, 2])] }]);
}

/** One row whose deepest field sits at `depth`, a top-level field counting 1: `depth - 1` structs around an Int32. */
export function nestedSchemaStream(depth: number): Uint8Array {
  let column: SparkIpcColumn = { name: "c", kind: "int32", values: [1] };
  for (let level = 1; level < depth; level += 1) column = { name: "c", kind: "struct", length: 1, children: [column] };
  return columnsStream([column]);
}

/** One row of `fields` Int32 columns. */
export function wideSchemaStream(fields: number): Uint8Array {
  return columnsStream(
    Array.from({ length: fields }, (_, index) => ({ name: `c${index}`, kind: "int32" as const, values: [index] })),
  );
}

/** A stream whose Utf8 column apache-arrow writes dictionary-encoded, so its schema field carries a dictionary. */
export function dictionaryColumnStream(): Uint8Array {
  return tableToIPC(tableFromArrays({ v: ["a", "b", "a"] }), "stream");
}

const END = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

interface FramedMessage {
  readonly start: number;
  readonly metadata: number;
  readonly body: number;
  readonly end: number;
  readonly header: number;
}

/** The messages of a well-formed stream: where each starts, its header's root table, its body and its end. */
function framedMessages(stream: Uint8Array): FramedMessage[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const out: FramedMessage[] = [];
  let at = 0;
  for (;;) {
    const length = view.getInt32(at + 4, true);
    if (length === 0) return out;
    const metadata = at + 8;
    const root = metadata + view.getUint32(metadata, true);
    const vtable = root - view.getInt32(root, true);
    const slot = view.getUint16(vtable, true) > 10 ? view.getUint16(vtable + 10, true) : 0;
    const bodyLength = slot === 0 ? 0 : Number(view.getBigInt64(root + slot, true));
    const body = metadata + length;
    out.push({ start: at, metadata, body, end: body + bodyLength, header: root });
    at = body + bodyLength;
  }
}

/** A malformed stream, hand-built from a well-formed one. */
export function malformedStream(
  kind: "no-continuation" | "metadata-too-large" | "body-past-end" | "no-end-marker" | "dictionary-batch",
): Uint8Array {
  const good = int64Batch(0, 4);
  switch (kind) {
    case "no-continuation":
      return good.slice(4);
    case "metadata-too-large": {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setUint32(0, 0xffffffff, true);
      new DataView(out.buffer).setInt32(4, 1_048_576 + 8, true);
      return out;
    }
    case "body-past-end":
      return good.slice(0, good.byteLength - 16);
    case "no-end-marker":
      return good.slice(0, good.byteLength - 8);
    case "dictionary-batch": {
      const schema = framedMessages(good)[0];
      const dictionary = dictionaryColumnStream();
      const batch = framedMessages(dictionary)[1];
      return concat([good.slice(schema.start, schema.end), dictionary.slice(batch.start, batch.end), END]);
    }
  }
}

/** One change to the last record batch's header or body, for the pre-check's length checks. */
export type SparkIpcBatchPatch =
  | { readonly kind: "node-count"; readonly count: number }
  | { readonly kind: "buffer-count"; readonly count: number }
  | { readonly kind: "node"; readonly index: number; readonly length?: bigint; readonly nullCount?: bigint }
  | { readonly kind: "buffer"; readonly index: number; readonly offset?: bigint; readonly length?: bigint }
  | { readonly kind: "int32"; readonly buffer: number; readonly at: number; readonly value: number };

/** A copy of `stream` with one value of its last record batch changed in place. */
export function patchRecordBatch(stream: Uint8Array, patch: SparkIpcBatchPatch): Uint8Array {
  const out = stream.slice();
  const view = new DataView(out.buffer);
  const message = framedMessages(out).at(-1)!;
  const field = (table: number, slot: number) => {
    const vtable = table - view.getInt32(table, true);
    return table + view.getUint16(vtable + 4 + slot * 2, true);
  };
  const target = (at: number) => at + view.getUint32(at, true);
  const batch = target(field(message.header, 2));
  const nodes = target(field(batch, 1));
  const buffers = target(field(batch, 2));
  switch (patch.kind) {
    case "node-count":
      view.setUint32(nodes, patch.count, true);
      break;
    case "buffer-count":
      view.setUint32(buffers, patch.count, true);
      break;
    case "node":
      if (patch.length !== undefined) view.setBigInt64(nodes + 4 + 16 * patch.index, patch.length, true);
      if (patch.nullCount !== undefined) view.setBigInt64(nodes + 12 + 16 * patch.index, patch.nullCount, true);
      break;
    case "buffer":
      if (patch.offset !== undefined) view.setBigInt64(buffers + 4 + 16 * patch.index, patch.offset, true);
      if (patch.length !== undefined) view.setBigInt64(buffers + 12 + 16 * patch.index, patch.length, true);
      break;
    case "int32": {
      const offset = Number(view.getBigInt64(buffers + 4 + 16 * patch.buffer, true));
      view.setInt32(message.body + offset + 4 * patch.at, patch.value, true);
      break;
    }
  }
  return out;
}
