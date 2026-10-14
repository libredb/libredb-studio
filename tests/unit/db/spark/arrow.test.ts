import { describe, expect, test } from "bun:test";
import { captureBytes, readSparkCapture, type SparkCaptureVersion } from "../../../helpers/spark-captures";
import { columnsStream, int64Batch, patchRecordBatch, stringBatch } from "../../../helpers/spark-ipc";
import {
  type ArrowColumnData,
  type ArrowColumns,
  type ArrowTypeName,
  readIpcColumns,
  rowCost,
} from "@/lib/db/providers/sql/spark/arrow";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import { checkIpcStream, SPARK_IPC_FAILURES } from "@/lib/db/providers/sql/spark/ipc-guard";

const ARROW_TYPES = new Set<ArrowTypeName>([
  "null",
  "bool",
  "int8",
  "int16",
  "int32",
  "int64",
  "float32",
  "float64",
  "decimal128",
  "utf8",
  "binary",
  "date32",
  "timestamp",
  "time64",
  "interval-year-month",
  "interval-month-day-nano",
  "duration",
  "list",
  "map",
  "struct",
]);

/** The relation batches of the captured every-type SELECT, each one IPC stream (one chunk each at this size). */
function everyTypeStreams(version: SparkCaptureVersion): Uint8Array[] {
  const capture = readSparkCapture(version, "every-type-relation");
  if (capture.outcome !== "pass" || !Array.isArray(capture.payload))
    throw new Error("every-type-relation is not a pass list");
  return capture.payload
    .filter(
      (response): response is { arrow_batch: { data: unknown } } =>
        typeof response === "object" && response !== null && "arrow_batch" in response,
    )
    .map((response) => captureBytes(response.arrow_batch.data));
}

/** The inline answer of the captured SHOW TABLES command: one IPC stream in its `local_relation`. */
function showTablesStream(version: SparkCaptureVersion): Uint8Array {
  const capture = readSparkCapture(version, "show-tables-inline");
  if (capture.outcome !== "pass" || !Array.isArray(capture.payload))
    throw new Error("show-tables-inline is not a pass list");
  const answers = capture.payload.filter(
    (response): response is { sql_command_result: { relation: { local_relation: { data: unknown } } } } =>
      typeof response === "object" && response !== null && "sql_command_result" in response,
  );
  expect(answers).toHaveLength(1);
  return captureBytes(answers[0].sql_command_result.relation.local_relation.data);
}

/** A column of `columns` by its name. */
function named(columns: ArrowColumns, name: string): ArrowColumnData {
  const column = columns.columns.find((candidate) => candidate.name === name);
  if (column === undefined) throw new Error(`no column ${name}`);
  return column;
}

/** A little-endian reader over a column's values buffer. */
function valuesOf(column: ArrowColumnData): DataView {
  if (column.values === undefined) throw new Error(`column ${column.name} has no values buffer`);
  return new DataView(column.values.buffer, column.values.byteOffset, column.values.byteLength);
}

/** The SparkError `run` throws; anything else thrown, or nothing, fails the test. */
function refusal(run: () => unknown): SparkError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SparkError);
    return error as SparkError;
  }
  throw new Error("expected a SparkError, and nothing was thrown");
}

describe("readIpcColumns over Spark's own bytes", () => {
  for (const version of ["4.2.0", "4.1.3"] as const) {
    test(`the every-type batch of ${version}: 34 columns, every one a mapped type with its raw buffers`, () => {
      const streams = everyTypeStreams(version);
      expect(streams.length).toBeGreaterThan(0);
      const columns = readIpcColumns(streams[0]);
      expect(columns.columns).toHaveLength(34);
      for (const column of columns.columns) {
        expect(ARROW_TYPES.has(column.type)).toBe(true);
        expect(column.length).toBe(columns.rowCount);
        if (column.type === "utf8" || column.type === "binary" || column.type === "list" || column.type === "map") {
          expect(column.offsets).toBeInstanceOf(Int32Array);
          expect(column.offsets!.length).toBe(column.length + 1);
        }
        if (column.type === "decimal128") expect(typeof column.scale).toBe("number");
        if (column.type === "timestamp")
          expect(column.timezone === null || typeof column.timezone === "string").toBe(true);
        expect(rowCost(columns, 0)).toBeGreaterThanOrEqual(8 * columns.columns.length);
      }
    });

    test(`the every-type batch of ${version}: each column's raw buffers hold the row the sample table stores`, () => {
      const columns = readIpcColumns(everyTypeStreams(version)[0]);
      expect(columns.rowCount).toBe(1);
      expect(columns.columns.map((column) => [column.name, column.type])).toStrictEqual([
        ["c_boolean", "bool"],
        ["c_tinyint", "int8"],
        ["c_smallint", "int16"],
        ["c_int", "int32"],
        ["c_bigint_safe", "int64"],
        ["c_bigint_large", "int64"],
        ["c_float", "float32"],
        ["c_double", "float64"],
        ["c_double_nan", "float64"],
        ["c_double_inf", "float64"],
        ["c_decimal", "decimal128"],
        ["c_decimal_neg", "decimal128"],
        ["c_decimal_38", "decimal128"],
        ["c_string", "utf8"],
        ["c_string_collated", "utf8"],
        ["c_char", "utf8"],
        ["c_varchar", "utf8"],
        ["c_binary", "binary"],
        ["c_date", "date32"],
        ["c_date_min", "date32"],
        ["c_timestamp", "timestamp"],
        ["c_timestamp_ntz", "timestamp"],
        ["c_ym_interval", "interval-year-month"],
        ["c_year_interval", "interval-year-month"],
        ["c_dt_interval", "duration"],
        ["c_hour_interval", "duration"],
        ["c_array", "list"],
        ["c_map", "map"],
        ["c_map_nested_key", "map"],
        ["c_struct", "struct"],
        ["c_variant", "struct"],
        ["c_null_int", "int32"],
        ["c_void", "null"],
        ["c_calendar_interval", "interval-month-day-nano"],
      ]);
      const value = (name: string) => valuesOf(named(columns, name));
      expect(value("c_boolean").getUint8(0) & 1).toBe(1);
      expect(value("c_tinyint").getInt8(0)).toBe(-7);
      expect(value("c_smallint").getInt16(0, true)).toBe(-300);
      expect(value("c_int").getInt32(0, true)).toBe(-70000);
      expect(value("c_bigint_large").getBigInt64(0, true)).toBe(BigInt("9223372036854775807"));
      expect(value("c_float").getFloat32(0, true)).toBe(Math.fround(0.1));
      expect(value("c_double_nan").getFloat64(0, true)).toBeNaN();
      // A decimal's 16 bytes are one little-endian two's complement integer, its point placed by the scale.
      expect(named(columns, "c_decimal")).toMatchObject({ type: "decimal128", precision: 10, scale: 2 });
      expect(value("c_decimal").getBigInt64(0, true)).toBe(BigInt(1234567891));
      expect([value("c_decimal_neg").getBigInt64(0, true), value("c_decimal_neg").getBigInt64(8, true)]).toStrictEqual([
        BigInt(-5),
        BigInt(-1),
      ]);
      const wide = value("c_decimal_38");
      expect((wide.getBigInt64(8, true) << BigInt(64)) | wide.getBigUint64(0, true)).toBe(
        BigInt("12345678901234567890123456789012345678"),
      );
      const text = named(columns, "c_string");
      expect(Array.from(text.offsets!)).toStrictEqual([0, 14]);
      expect(new TextDecoder().decode(text.values)).toBe("héllo, wörld");
      expect(new TextDecoder().decode(named(columns, "c_char").values)).toBe("ab   ");
      expect(Array.from(named(columns, "c_binary").values!)).toStrictEqual([0x00, 0xff, 0x10]);
      expect(value("c_date_min").getInt32(0, true)).toBe(-719162);
      expect(named(columns, "c_timestamp").timezone).toBe("Etc/UTC");
      expect(value("c_timestamp").getBigInt64(0, true)).toBe(
        BigInt(Date.UTC(2026, 9, 13, 12, 34, 56, 789)) * BigInt(1000),
      );
      expect(named(columns, "c_timestamp_ntz").timezone).toBeNull();
      expect(value("c_timestamp_ntz").getBigInt64(0, true)).toBe(
        BigInt(Date.UTC(2026, 9, 13, 12, 34, 56)) * BigInt(1000) + BigInt(123456),
      );
      expect(value("c_ym_interval").getInt32(0, true)).toBe(43);
      expect(value("c_dt_interval").getBigInt64(0, true)).toBe(BigInt(93784567891));
      const calendar = value("c_calendar_interval");
      expect([calendar.getInt32(0, true), calendar.getInt32(4, true), calendar.getBigInt64(8, true)]).toStrictEqual([
        14,
        25,
        BigInt(18367000008000),
      ]);
      const array = named(columns, "c_array");
      expect(Array.from(array.offsets!)).toStrictEqual([0, 3]);
      expect(array.children[0]).toMatchObject({ name: "element", type: "int32", length: 3, nullCount: 1 });
      expect(array.children[0].validity![0] & 0b111).toBe(0b011);
      const map = named(columns, "c_map");
      expect(Array.from(map.offsets!)).toStrictEqual([0, 2]);
      expect(map.children.map((entries) => [entries.type, entries.length])).toStrictEqual([["struct", 2]]);
      expect(map.children[0].children.map((child) => [child.name, child.type])).toStrictEqual([
        ["key", "utf8"],
        ["value", "int32"],
      ]);
      expect(named(columns, "c_map_nested_key").children[0].children[0].type).toBe("list");
      expect(named(columns, "c_struct").children.map((child) => [child.name, child.type])).toStrictEqual([
        ["x", "int32"],
        ["y", "utf8"],
      ]);
      const variant = named(columns, "c_variant");
      expect(variant.children.map((child) => [child.name, child.type])).toStrictEqual([
        ["value", "binary"],
        ["metadata", "binary"],
      ]);
      expect(variant.children[1].metadata.get("variant")).toBe("true");
      const nullInt = named(columns, "c_null_int");
      expect(nullInt.nullCount).toBe(1);
      expect(nullInt.validity![0] & 1).toBe(0);
      expect(named(columns, "c_void")).toStrictEqual({
        name: "c_void",
        type: "null",
        length: 1,
        nullCount: 1,
        validity: undefined,
        values: undefined,
        offsets: undefined,
        children: [],
        metadata: new Map(),
      });
    });

    test(`the inline SHOW TABLES answer of ${version}: its three columns and three rows`, () => {
      const columns = readIpcColumns(showTablesStream(version));
      expect(columns.rowCount).toBe(3);
      expect(columns.columns.map((column) => [column.name, column.type, column.length])).toStrictEqual([
        ["namespace", "utf8", 3],
        ["tableName", "utf8", 3],
        ["isTemporary", "bool", 3],
      ]);
    });
  }
});

describe("readIpcColumns: fields and raw buffers per type", () => {
  test("hands over names, types, lengths, null counts, validity, raw values and offsets", () => {
    const columns = readIpcColumns(
      columnsStream([
        { name: "i", kind: "int64", values: [BigInt(1), null, BigInt(-3)] },
        { name: "s", kind: "utf8", values: ["ab", "", "cde"] },
        { name: "b", kind: "bool", values: [true, false, true] },
        { name: "d", kind: "decimal", precision: 10, scale: 2, values: [BigInt(1234567891), BigInt(0), BigInt(-50)] },
        { name: "ts", kind: "timestamp-utc", values: [BigInt(0), BigInt(1), BigInt(2)] },
        { name: "ntz", kind: "timestamp-ntz", values: [BigInt(0), BigInt(1), BigInt(2)] },
        { name: "t", kind: "time64-ns", values: [BigInt(0), BigInt(1), BigInt("86399999999999")] },
      ]),
    );
    expect(columns.rowCount).toBe(3);
    const [i, s, b, d, ts, ntz, t] = columns.columns;
    expect(i).toMatchObject({ name: "i", type: "int64", length: 3, nullCount: 1 });
    expect(i.validity![0] & 0b111).toBe(0b101);
    expect(new DataView(i.values!.buffer, i.values!.byteOffset).getBigInt64(16, true)).toBe(BigInt(-3));
    expect(s).toMatchObject({ type: "utf8", nullCount: 0, validity: undefined });
    expect(Array.from(s.offsets!)).toStrictEqual([0, 2, 2, 5]);
    expect(new TextDecoder().decode(s.values!.subarray(2, 5))).toBe("cde");
    expect(b.type).toBe("bool");
    expect(b.values![0] & 0b111).toBe(0b101);
    expect(d).toMatchObject({ type: "decimal128", precision: 10, scale: 2 });
    expect(d.values!.byteLength).toBeGreaterThanOrEqual(48);
    expect(ts).toMatchObject({ type: "timestamp", timezone: "UTC" });
    expect(ntz.timezone).toBeNull();
    expect(t).toMatchObject({ type: "time64", length: 3 });
    expect(valuesOf(t).getBigInt64(16, true)).toBe(BigInt("86399999999999"));
    // The exact shape: precision and scale only on a decimal, a time zone only on a timestamp.
    const shape = (column: ArrowColumnData) => ({
      name: column.name,
      type: column.type,
      length: 3,
      nullCount: column.nullCount,
      validity: column.nullCount > 0 ? expect.any(Uint8Array) : undefined,
      values: expect.any(Uint8Array),
      offsets: column.type === "utf8" ? expect.any(Int32Array) : undefined,
      children: [],
      metadata: new Map(),
    });
    expect(i).toStrictEqual(shape(i));
    expect(s).toStrictEqual(shape(s));
    expect(d).toStrictEqual({ ...shape(d), precision: 10, scale: 2 });
    expect(ts).toStrictEqual({ ...shape(ts), timezone: "UTC" });
    expect(ntz).toStrictEqual({ ...shape(ntz), timezone: null });
  });

  test("a string column whose every value is empty still hands over its values buffer, empty", () => {
    const [empty] = readIpcColumns(columnsStream([{ name: "e", kind: "utf8", values: ["", ""] }])).columns;
    // apache-arrow pads this offsets buffer from 12 bytes to 16, and the column hands over its first length + 1 offsets.
    expect(Array.from(empty.offsets!)).toStrictEqual([0, 0, 0]);
    expect(empty.values).toBeInstanceOf(Uint8Array);
    expect(empty.values!.byteLength).toBe(0);
  });

  test("nested columns carry their children and the field metadata Spark tags them with", () => {
    const columns = readIpcColumns(
      columnsStream([
        { name: "l", kind: "list", offsets: [0, 2], child: { name: "element", kind: "int32", values: [1, 2] } },
        {
          name: "m",
          kind: "map",
          offsets: [0, 1],
          keys: { name: "key", kind: "utf8", values: ["k"] },
          items: { name: "value", kind: "int32", values: [7] },
        },
        {
          name: "v",
          kind: "struct",
          length: 1,
          children: [
            { name: "value", kind: "binary", values: [new Uint8Array([12])] },
            { name: "metadata", kind: "binary", values: [new Uint8Array([1, 0, 0])], metadata: { variant: "true" } },
          ],
        },
      ]),
    );
    const [list, map, variant] = columns.columns;
    expect(list.children.map((child) => child.type)).toStrictEqual(["int32"]);
    expect(map.children[0].type).toBe("struct");
    expect(map.children[0].children.map((child) => child.name)).toStrictEqual(["key", "value"]);
    expect(variant.children[1].metadata.get("variant")).toBe("true");
  });

  test("a stream of no batch, or of one batch of no rows, answers zero rows with its schema's columns", () => {
    const zeroRows = columnsStream([{ name: "x", kind: "int32", values: [] }]);
    const schemaOnly = new Uint8Array(firstMessageLength(zeroRows) + 8);
    schemaOnly.set(zeroRows.subarray(0, firstMessageLength(zeroRows)), 0);
    schemaOnly.set(END_MARKER, firstMessageLength(zeroRows));
    expect([checkIpcStream(schemaOnly).batches, checkIpcStream(zeroRows).batches]).toStrictEqual([0, 1]);
    for (const stream of [schemaOnly, zeroRows]) {
      const columns = readIpcColumns(stream);
      expect(columns.rowCount).toBe(0);
      expect(columns.columns.map((column) => [column.name, column.type, column.length])).toStrictEqual([
        ["x", "int32", 0],
      ]);
      // apache-arrow holds no buffer for this Int32 column of no rows, so none is handed over.
      expect(columns.columns[0].values).toBeUndefined();
    }
  });

  test("a metadata entry without a value reads as an empty value, as Arrow's reference reader reads it", () => {
    // Arrow's Schema.fbs makes a metadata value optional; apache-arrow reads an absent one as null.
    const valueless = withoutSlot(
      columnsStream([{ name: "s", kind: "utf8", values: ["a"], metadata: { k: "v" } }]),
      firstMetadataEntry,
      1,
    );
    expect([...readIpcColumns(valueless).columns[0].metadata]).toStrictEqual([["k", ""]]);
  });
});

describe("readIpcColumns: refusals", () => {
  test("a stream the pre-check refuses never reaches apache-arrow", () => {
    expect(() => readIpcColumns(new Uint8Array([1, 2, 3]))).toThrow(SparkError);
    expect(refusal(() => readIpcColumns(new Uint8Array([1, 2, 3]))).message).toBe(
      SPARK_ERROR_SENTENCES.unreadable(SPARK_IPC_FAILURES.endMarker),
    );
  });

  test("a type the decoder does not map is refused even when the stream passed the pre-check's framing", () => {
    expect(() => readIpcColumns(columnsStream([{ name: "c", kind: "uint8", values: [1] }]))).toThrow(SparkError);
    const error = refusal(() => readIpcColumns(columnsStream([{ name: "c", kind: "uint8", values: [1] }])));
    expect([error.category, error.message]).toStrictEqual([
      "unreadable",
      SPARK_ERROR_SENTENCES.unreadable(SPARK_IPC_FAILURES.type),
    ]);
  });

  test("two record batches in one stream are refused, as Spark sends one", () => {
    const one = int64Batch(0, 1);
    const two = new Uint8Array(one.byteLength * 2 - 8);
    // The schema and batch of one stream, then the second stream's batch and end marker, without its schema.
    const schemaEnd = firstMessageLength(one);
    two.set(one.subarray(0, one.byteLength - 8), 0);
    two.set(one.subarray(schemaEnd), one.byteLength - 8);
    const stream = two.subarray(0, one.byteLength - 8 + one.byteLength - schemaEnd);
    expect(checkIpcStream(stream).batches).toBe(2);
    expect(() => readIpcColumns(stream)).toThrow(
      SPARK_ERROR_SENTENCES.unreadable("a stream with more than one record batch"),
    );
    expect(refusal(() => readIpcColumns(stream)).category).toBe("unreadable");
  });
});

/** The byte length of a stream's first message (the schema, which has no body), read from its framing. */
function firstMessageLength(stream: Uint8Array): number {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  return 8 + view.getInt32(4, true);
}

const END_MARKER = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);

/** Where an offset field of a FlatBuffers table points: its vtable entry locates the field, the field a uoffset. */
function fieldTarget(view: DataView, table: number, slot: number): number {
  const field = table + view.getUint16(table - view.getInt32(table, true) + 4 + 2 * slot, true);
  return field + view.getUint32(field, true);
}

/** The schema message's first field: Message.header (slot 2), Schema.fields (slot 1), element 0. */
function firstField(view: DataView, message: number): number {
  const fields = fieldTarget(view, fieldTarget(view, message, 2), 1);
  return fields + 4 + view.getUint32(fields + 4, true);
}

/** That field's first custom metadata entry: Field.custom_metadata (slot 6), element 0. */
function firstMetadataEntry(view: DataView, message: number): number {
  const entries = fieldTarget(view, firstField(view, message), 6);
  return entries + 4 + view.getUint32(entries + 4, true);
}

/**
 * A copy of a stream whose schema message leaves field `slot` of one table out, as a writer may leave out an optional
 * field. `locate` finds the table from the root table of the schema message. FlatBuffers shares one vtable between
 * tables of the same shape, so the helper does not edit that vtable: it appends a copy of it with the slot's entry at 0
 * to the schema message (grown by a multiple of 8, so the next message stays aligned) and points the table at the copy.
 */
function withoutSlot(
  stream: Uint8Array,
  locate: (view: DataView, message: number) => number,
  slot: number,
): Uint8Array {
  const source = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const metadataLength = source.getInt32(4, true);
  const metadataEnd = 8 + metadataLength;
  const table = locate(source, 8 + source.getUint32(8, true));
  const vtable = table - source.getInt32(table, true);
  const vtableSize = source.getUint16(vtable, true);
  const grown = Math.ceil(vtableSize / 8) * 8;
  const out = new Uint8Array(stream.byteLength + grown);
  out.set(stream.subarray(0, metadataEnd), 0);
  out.set(stream.subarray(vtable, vtable + vtableSize), metadataEnd);
  out.set(stream.subarray(metadataEnd), metadataEnd + grown);
  const view = new DataView(out.buffer);
  view.setInt32(4, metadataLength + grown, true);
  view.setUint16(metadataEnd + 4 + 2 * slot, 0, true);
  // A table's soffset is the table's position minus its vtable's, so a vtable after the table gives a negative one.
  view.setInt32(table, table - metadataEnd, true);
  return out;
}

describe("withoutSlot: the test helper that leaves one field out", () => {
  test("it leaves the field out of the located table only, though the tables share one vtable", () => {
    const stream = columnsStream([
      { name: "a", kind: "utf8", values: ["x"] },
      { name: "b", kind: "utf8", values: ["y"] },
    ]);
    // Field.name is slot 0; the two Utf8 fields are written with one shared vtable.
    const nameless = withoutSlot(stream, firstField, 0);
    expect(checkIpcStream(nameless).batches).toBe(1);
    expect(readIpcColumns(nameless).columns.map((column) => [column.name, column.type])).toStrictEqual([
      ["null", "utf8"],
      ["b", "utf8"],
    ]);
  });
});

describe("rowCost: the decoded cost of a row, from offsets, before any value is built", () => {
  test("8 bytes a value plus the UTF-8 length of a string and the byte length of a binary value", () => {
    const columns = readIpcColumns(
      columnsStream([
        { name: "s", kind: "utf8", values: ["héllo", "", null] },
        { name: "b", kind: "binary", values: [new Uint8Array(3), null, new Uint8Array(0)] },
        { name: "n", kind: "null", length: 3 },
      ]),
    );
    expect(rowCost(columns, 0)).toBe(8 + 6 + 8 + 3 + 8);
    expect(rowCost(columns, 1)).toBe(8 + 8 + 8);
    expect(rowCost(columns, 2)).toBe(24);
  });

  test("a nested value costs 8 for itself plus every element at every depth", () => {
    const columns = readIpcColumns(
      columnsStream([
        { name: "l", kind: "list", offsets: [0, 2, 2], child: { name: "element", kind: "utf8", values: ["ab", "c"] } },
        {
          name: "m",
          kind: "map",
          offsets: [0, 1, 1],
          keys: { name: "key", kind: "utf8", values: ["k"] },
          items: { name: "value", kind: "int32", values: [7] },
        },
        { name: "st", kind: "struct", length: 2, children: [{ name: "a", kind: "utf8", values: ["xyz", ""] }] },
      ]),
    );
    // list: 8 + (8 + 2) + (8 + 1); map: 8 + entry struct 8 + key (8 + 1) + value 8; struct: 8 + (8 + 3)
    expect(rowCost(columns, 0)).toBe(27 + 33 + 19);
    expect(rowCost(columns, 1)).toBe(8 + 8 + 16);
  });

  test("a list over a long Null child costs 8 for each element, read from its offsets", () => {
    const written = columnsStream([
      { name: "l", kind: "list", offsets: [0, 100_000], child: { name: "element", kind: "null", length: 100_000 } },
    ]);
    // apache-arrow 21.2.0 writes -1 as the null count of a nested Null child, which the pre-check refuses; the stream
    // carries the count a Null child has, its length, instead.
    const columns = readIpcColumns(patchRecordBatch(written, { kind: "node", index: 1, nullCount: BigInt(100_000) }));
    expect(columns.columns[0].children[0]).toMatchObject({ type: "null", length: 100_000, nullCount: 100_000 });
    expect(rowCost(columns, 0)).toBe(8 + 8 * 100_000);
  });

  test("an empty nested range costs nothing, even over a child of no values whose offsets buffer is empty", () => {
    // Arrow's format lets a column of no values carry an empty offsets buffer, and the pre-check takes one; apache-arrow
    // 21.2.0 writes the single offset instead, so the child's offsets buffer (the fourth buffer) is cut to nothing.
    const written = columnsStream([
      { name: "l", kind: "list", offsets: [0, 0, 0], child: { name: "element", kind: "utf8", values: [] } },
    ]);
    const columns = readIpcColumns(patchRecordBatch(written, { kind: "buffer", index: 3, length: BigInt(0) }));
    expect(columns.columns[0].children[0]).toMatchObject({ type: "utf8", length: 0 });
    expect(columns.columns[0].children[0].offsets).toStrictEqual(new Int32Array(0));
    expect([rowCost(columns, 0), rowCost(columns, 1)]).toStrictEqual([8, 8]);
  });

  test("a wide string batch costs its characters, which the result budgets read", () => {
    expect(rowCost(readIpcColumns(stringBatch(2, 100)), 1)).toBe(108);
    expect(rowCost(readIpcColumns(int64Batch(0, 2)), 0)).toBe(8);
  });

  test("a row outside the batch is refused with a RangeError, never costed", () => {
    const columns = readIpcColumns(stringBatch(2, 1));
    for (const row of [-1, 2, 0.5, Number.NaN]) expect(() => rowCost(columns, row)).toThrow(RangeError);
  });
});
