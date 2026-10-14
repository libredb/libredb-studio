import { describe, expect, test } from "bun:test";
import { readSparkCapture, captureBytes } from "../../../helpers/spark-captures";
import {
  columnsStream,
  dictionaryColumnStream,
  int64Batch,
  largeBinaryStream,
  largeUtf8Stream,
  malformedStream,
  nestedSchemaStream,
  patchRecordBatch,
  type SparkIpcColumn,
  stringBatch,
  wideSchemaStream,
} from "../../../helpers/spark-ipc";
import { checkIpcStream, SPARK_IPC_FAILURES } from "@/lib/db/providers/sql/spark/ipc-guard";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";

/** The refusal `checkIpcStream` raises for `what`, as the user reads it. */
function refusedWith(run: () => unknown, sentence: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SparkError);
  expect((caught as SparkError).category).toBe("unreadable");
  expect((caught as SparkError).message).toBe(sentence);
}
const unreadable = (what: keyof typeof SPARK_IPC_FAILURES) =>
  SPARK_ERROR_SENTENCES.unreadable(SPARK_IPC_FAILURES[what]);

/** A hand-built message with a FlatBuffers header holding only `header_type` and `bodyLength`. */
function handMessage(type: number | undefined, bodyLength: bigint | undefined): Uint8Array {
  const meta = new DataView(new ArrayBuffer(32));
  meta.setUint32(0, 16, true); // root table at 16
  meta.setUint16(4, 12, true); // vtable at 4: 12 bytes, 4 slots
  meta.setUint16(6, 16, true);
  meta.setUint16(10, type === undefined ? 0 : 12, true); // slot 1: header_type at table + 12
  meta.setUint16(14, bodyLength === undefined ? 0 : 4, true); // slot 3: bodyLength at table + 4
  meta.setInt32(16, 12, true); // the table's vtable is 12 bytes before it
  if (bodyLength !== undefined) meta.setBigInt64(20, bodyLength, true);
  if (type !== undefined) meta.setUint8(28, type);
  const out = new Uint8Array(8 + 32);
  new DataView(out.buffer).setUint32(0, 0xffffffff, true);
  new DataView(out.buffer).setInt32(4, 32, true);
  out.set(new Uint8Array(meta.buffer), 8);
  return out;
}
const END = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/** Where a FlatBuffers table keeps field `slot`, as the stream's writer laid it out (test streams only, no bounds). */
function slotAt(view: DataView, table: number, slot: number): number {
  const vtable = table - view.getInt32(table, true);
  return table + view.getUint16(vtable + 4 + 2 * slot, true);
}
const tableAt = (view: DataView, at: number) => at + view.getUint32(at, true);

/** The tables of a stream of a schema message, which has no body, then one record batch message. */
function tablesOf(stream: Uint8Array) {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const batchStart = 8 + view.getInt32(4, true);
  const fields = tableAt(view, slotAt(view, tableAt(view, slotAt(view, tableAt(view, 8), 2)), 1));
  const batchMessage = tableAt(view, batchStart + 8);
  return {
    view,
    batchStart,
    batchMessage,
    batch: tableAt(view, slotAt(view, batchMessage, 2)),
    field: (index: number) => tableAt(view, fields + 4 + 4 * index),
  };
}

/** The schema message of `schemaOf`, the record batch message of `batchOf`, and the end-of-stream marker. */
function splice(schemaOf: Uint8Array, batchOf: Uint8Array): Uint8Array {
  return join(schemaOf.slice(0, tablesOf(schemaOf).batchStart), batchOf.slice(tablesOf(batchOf).batchStart, -8), END);
}

/** `stream` with top-level field `index` given the Arrow type id `id` (Schema.fbs: Utf8 5, List 12). */
function retyped(stream: Uint8Array, index: number, id: number): Uint8Array {
  const out = stream.slice();
  const { view, field } = tablesOf(out);
  view.setUint8(slotAt(view, field(index), 2), id);
  return out;
}

/** One map<utf8, utf8> column of one row: a list of structs of a key and a value, as Arrow defines a map. */
function mapStream(): Uint8Array {
  return columnsStream([
    {
      name: "m",
      kind: "map",
      offsets: [0, 1],
      keys: { name: "key", kind: "utf8", values: ["k"] },
      items: { name: "value", kind: "utf8", values: ["v"] },
    },
  ]);
}

/**
 * A schema of no fields, then a hand-built record batch of no rows, nodes or buffers whose variadicBufferCounts holds
 * `counts`, or which has no such field when `counts` is undefined, as apache-arrow writes a batch without view columns.
 */
function variadicStream(counts: readonly bigint[] | undefined): Uint8Array {
  const size = 96 + 8 * (counts?.length ?? 0);
  const meta = new DataView(new ArrayBuffer(size));
  meta.setUint32(0, 16, true); // root table at 16
  // The message's vtable at 4: version at +16, header_type at +18, header at +4, bodyLength (0) at +8.
  [12, 24, 16, 18, 4, 8].forEach((value, index) => meta.setUint16(4 + 2 * index, value, true));
  meta.setInt32(16, 12, true);
  meta.setUint32(20, 36, true); // the header: the record batch table at 56
  meta.setInt16(32, 4, true); // metadata version V5
  meta.setUint8(34, 3); // RecordBatch
  // The batch's vtable at 40: length (0) at +8, nodes at +4, buffers at +16, no compression, and variadicBufferCounts
  // at +20 when `counts` is given.
  [14, 24, 8, 4, 16, 0, counts === undefined ? 0 : 20].forEach((value, index) =>
    meta.setUint16(40 + 2 * index, value, true),
  );
  meta.setInt32(56, 16, true);
  meta.setUint32(60, 20, true); // nodes: an empty vector at 80
  meta.setUint32(72, 16, true); // buffers: an empty vector at 88
  if (counts !== undefined) {
    meta.setUint32(76, 16, true); // variadicBufferCounts at 92, its values from 96
    meta.setUint32(92, counts.length, true);
    counts.forEach((count, index) => meta.setBigInt64(96 + 8 * index, count, true));
  }
  const message = new Uint8Array(8 + size);
  new DataView(message.buffer).setUint32(0, 0xffffffff, true);
  new DataView(message.buffer).setInt32(4, size, true);
  message.set(new Uint8Array(meta.buffer), 8);
  const schema = columnsStream([]);
  return join(schema.slice(0, tablesOf(schema).batchStart), message, END);
}

/** Every Arrow IPC stream an ExecutePlan capture holds: relation batches and inline command answers. */
function capturedStreams(name: "compressed-zstd" | "compressed-lz4"): Uint8Array[] {
  const capture = readSparkCapture("4.2.0", name);
  if (capture.outcome !== "pass") throw new Error(`${name} is not a pass capture`);
  const found: Uint8Array[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "data" && typeof inner === "object" && inner !== null && "$bytes" in inner)
          found.push(captureBytes(inner));
        else visit(inner);
      }
    }
  };
  visit(capture.payload);
  return found;
}

describe("checkIpcStream: well-formed streams", () => {
  test("reads streams apache-arrow writes and counts fields, depth and batches", () => {
    expect(checkIpcStream(int64Batch(0, 4))).toStrictEqual({ fields: 1, depth: 1, batches: 1 });
    expect(checkIpcStream(stringBatch(3, 10), 3)).toStrictEqual({ fields: 1, depth: 1, batches: 1 });
    // A schema of no fields and one batch of no rows.
    expect(checkIpcStream(columnsStream([]))).toStrictEqual({ fields: 0, depth: 0, batches: 1 });
  });

  test("reads every type the value mapper reads, nested ones included", () => {
    const stream = columnsStream([
      { name: "n", kind: "null", length: 2 },
      { name: "b", kind: "bool", values: [true, null] },
      { name: "i8", kind: "int8", values: [1, null] },
      { name: "i16", kind: "int16", values: [1, 2] },
      { name: "i32", kind: "int32", values: [1, 2] },
      { name: "i64", kind: "int64", values: [BigInt(1), BigInt(2)] },
      { name: "f32", kind: "float32", values: [0.5, 1] },
      { name: "f64", kind: "float64", values: [0.5, 1] },
      { name: "d", kind: "decimal", precision: 10, scale: 2, values: [BigInt(1234567891), BigInt(-50)] },
      { name: "s", kind: "utf8", values: ["a", null] },
      { name: "bin", kind: "binary", values: [new Uint8Array([1]), null] },
      { name: "day", kind: "date32", values: [0, -719162] },
      { name: "ts", kind: "timestamp-utc", values: [BigInt(0), BigInt(1)] },
      { name: "ntz", kind: "timestamp-ntz", values: [BigInt(0), BigInt(1)] },
      { name: "t", kind: "time64-ns", values: [BigInt(0), BigInt(1)] },
      { name: "ym", kind: "interval-ym", values: [43, -1] },
      { name: "dt", kind: "duration-us", values: [BigInt(93784567891), BigInt(0)] },
      { name: "cal", kind: "interval-mdn", values: [{ months: 1, days: 2, nanos: BigInt(3000) }, null] },
      { name: "l", kind: "list", offsets: [0, 2, 2], child: { name: "element", kind: "int32", values: [1, 2] } },
      {
        name: "m",
        kind: "map",
        offsets: [0, 1, 1],
        keys: { name: "key", kind: "utf8", values: ["k"] },
        items: { name: "value", kind: "int32", values: [1] },
      },
      { name: "st", kind: "struct", length: 2, children: [{ name: "a", kind: "int32", values: [1, 2] }] },
    ]);
    expect(checkIpcStream(stream, 2)).toStrictEqual({ fields: 26, depth: 3, batches: 1 });
  });

  test("reads 64 levels and 10,000 fields, the bounds themselves", () => {
    expect(checkIpcStream(nestedSchemaStream(64)).depth).toBe(64);
    expect(checkIpcStream(wideSchemaStream(10_000)).fields).toBe(10_000);
  });

  test("counts the batches: a schema with none, and two whose rows sum to the declared count and to no other", () => {
    const first = int64Batch(0, 4);
    const schemaOnly = join(first.slice(0, tablesOf(first).batchStart), END);
    expect(checkIpcStream(schemaOnly, 0)).toStrictEqual({ fields: 1, depth: 1, batches: 0 });
    const second = int64Batch(4, 3);
    const two = join(first.slice(0, -8), second.slice(tablesOf(second).batchStart, -8), END);
    expect(checkIpcStream(two, 7)).toStrictEqual({ fields: 1, depth: 1, batches: 2 });
    for (const declared of [0, 3, 4, 6, 8]) refusedWith(() => checkIpcStream(two, declared), unreadable("rowCount"));
  });
});

describe("checkIpcStream: refusals before apache-arrow reads a byte", () => {
  test("framing: no continuation marker, trailing bytes, a header too long or negative, a body past the end, no end marker", () => {
    refusedWith(() => checkIpcStream(malformedStream("no-continuation")), unreadable("framing"));
    refusedWith(() => checkIpcStream(join(int64Batch(0, 1), new Uint8Array([0]))), unreadable("framing"));
    refusedWith(() => checkIpcStream(malformedStream("metadata-too-large")), unreadable("metadata"));
    refusedWith(
      () => checkIpcStream(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xfb, 0xff, 0xff, 0xff])),
      unreadable("metadata"),
    );
    refusedWith(() => checkIpcStream(malformedStream("body-past-end")), unreadable("body"));
    refusedWith(() => checkIpcStream(join(handMessage(1, BigInt(1000)), END)), unreadable("body"));
    refusedWith(() => checkIpcStream(join(handMessage(1, BigInt(-1)), END)), unreadable("body"));
    refusedWith(() => checkIpcStream(malformedStream("no-end-marker")), unreadable("endMarker"));
    refusedWith(() => checkIpcStream(new Uint8Array(0)), unreadable("endMarker"));
  });

  test("a header whose offsets leave it, or whose int64 is not a safe integer", () => {
    const outside = new Uint8Array([0xff, 0xff, 0xff, 0xff, 8, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]);
    refusedWith(() => checkIpcStream(join(outside, END)), unreadable("header"));
    refusedWith(() => checkIpcStream(join(handMessage(1, BigInt(2 ** 62)), END)), unreadable("header"));
    refusedWith(() => checkIpcStream(join(handMessage(1, BigInt(0)), END)), unreadable("header"));
  });

  test("order and message types: a batch before the schema, a second schema, a dictionary batch, a tensor, no schema", () => {
    refusedWith(() => checkIpcStream(join(handMessage(3, BigInt(0)), END)), unreadable("order"));
    const ints = int64Batch(0, 4);
    const { batchStart } = tablesOf(ints);
    refusedWith(
      () => checkIpcStream(join(ints.slice(0, batchStart), ints.slice(0, batchStart), ints.slice(batchStart))),
      unreadable("order"),
    );
    refusedWith(() => checkIpcStream(END), unreadable("order"));
    refusedWith(() => checkIpcStream(malformedStream("dictionary-batch")), unreadable("messageType"));
    refusedWith(() => checkIpcStream(join(handMessage(4, BigInt(0)), END)), unreadable("messageType"));
  });

  test("schema: a dictionary-encoded field, 65 levels, 10,001 fields, and every Arrow type left unread", () => {
    refusedWith(() => checkIpcStream(dictionaryColumnStream()), unreadable("dictionary"));
    refusedWith(() => checkIpcStream(nestedSchemaStream(65)), unreadable("depth"));
    refusedWith(() => checkIpcStream(wideSchemaStream(10_001)), unreadable("fields"));
    for (const kind of ["uint8", "float16", "date64", "timestamp-ms"] as const) {
      refusedWith(() => checkIpcStream(columnsStream([{ name: "c", kind, values: [1] }])), unreadable("type"));
    }
    // A run-end encoded array and the view types (Schema.fbs: RunEndEncoded 22, BinaryView 23, Utf8View 24, ListView
    // 25, LargeListView 26), retyped from a string column.
    for (const id of [22, 23, 24, 25, 26]) {
      refusedWith(() => checkIpcStream(retyped(stringBatch(1, 2), 0, id)), unreadable("type"));
    }
  });

  test("a decimal outside Spark's DecimalType, precision 1 to 38 and a scale up to it, or scaled below -38", () => {
    const decimal = (precision: number, scale: number) =>
      columnsStream([{ name: "d", kind: "decimal", precision, scale, values: [BigInt(1)] }]);
    for (const [precision, scale] of [
      [0, 0],
      [39, 0],
      [38, 39],
      [10, -39],
    ]) {
      refusedWith(() => checkIpcStream(decimal(precision, scale)), unreadable("type"));
    }
    for (const [precision, scale] of [
      [38, 38],
      [10, -38],
      [10, 2],
    ]) {
      expect(checkIpcStream(decimal(precision, scale))).toStrictEqual({ fields: 1, depth: 1, batches: 1 });
    }
  });

  test("large string and binary types get their own sentence", () => {
    refusedWith(() => checkIpcStream(largeUtf8Stream()), SPARK_ERROR_SENTENCES.largeVarTypes);
    refusedWith(() => checkIpcStream(largeBinaryStream()), SPARK_ERROR_SENTENCES.largeVarTypes);
  });

  test("the captured zstd and lz4 batches are refused naming their codec", () => {
    for (const [name, codec] of [
      ["compressed-zstd", "zstd"],
      ["compressed-lz4", "lz4"],
    ] as const) {
      const streams = capturedStreams(name);
      expect(streams.length).toBeGreaterThan(0);
      refusedWith(() => checkIpcStream(streams[streams.length - 1]), SPARK_ERROR_SENTENCES.compressed(codec));
    }
  });

  test("record batch: a declared row count, node and buffer counts, lengths, buffers, bitmaps, values and offsets", () => {
    const ints = int64Batch(0, 4);
    refusedWith(() => checkIpcStream(ints, 3), unreadable("rowCount"));
    // Counts are lowered, never raised, so the vector the guard reads stays inside the header.
    refusedWith(() => checkIpcStream(patchRecordBatch(ints, { kind: "node-count", count: 0 })), unreadable("nodes"));
    refusedWith(() => checkIpcStream(patchRecordBatch(ints, { kind: "buffer-count", count: 1 })), unreadable("nodes"));
    refusedWith(
      () => checkIpcStream(patchRecordBatch(ints, { kind: "node", index: 0, length: BigInt(-1) })),
      unreadable("length"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(ints, { kind: "node", index: 0, length: BigInt(5) })),
      unreadable("length"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(ints, { kind: "node", index: 0, nullCount: BigInt(5) })),
      unreadable("length"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(ints, { kind: "buffer", index: 1, offset: BigInt(1 << 20) })),
      unreadable("buffers"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(ints, { kind: "buffer", index: 1, length: BigInt(8) })),
      unreadable("values"),
    );
    refusedWith(
      () =>
        checkIpcStream(
          patchRecordBatch(patchRecordBatch(ints, { kind: "node", index: 0, nullCount: BigInt(1) }), {
            kind: "buffer",
            index: 0,
            length: BigInt(0),
          }),
        ),
      unreadable("validity"),
    );
    // Offsets 0, 2, 4, 6 over 6 bytes of data, in a data buffer apache-arrow pads to 8 bytes: 8 is in bounds, 9 is not.
    const strings = stringBatch(3, 2);
    expect(checkIpcStream(patchRecordBatch(strings, { kind: "int32", buffer: 1, at: 3, value: 8 }))).toStrictEqual({
      fields: 1,
      depth: 1,
      batches: 1,
    });
    refusedWith(
      () => checkIpcStream(patchRecordBatch(strings, { kind: "int32", buffer: 1, at: 2, value: 1 })),
      unreadable("offsets"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(strings, { kind: "int32", buffer: 1, at: 3, value: 9 })),
      unreadable("offsets"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(strings, { kind: "int32", buffer: 1, at: 0, value: -1 })),
      unreadable("offsets"),
    );
    refusedWith(
      () => checkIpcStream(patchRecordBatch(strings, { kind: "buffer", index: 1, length: BigInt(4) })),
      unreadable("offsets"),
    );
    const list = columnsStream([
      { name: "l", kind: "list", offsets: [0, 2], child: { name: "element", kind: "int32", values: [1, 2] } },
    ]);
    refusedWith(
      () => checkIpcStream(patchRecordBatch(list, { kind: "int32", buffer: 1, at: 1, value: 3 })),
      unreadable("offsets"),
    );
    const struct = columnsStream([
      { name: "s", kind: "struct", length: 2, children: [{ name: "a", kind: "int32", values: [1, 2] }] },
    ]);
    refusedWith(
      () => checkIpcStream(patchRecordBatch(struct, { kind: "node", index: 1, length: BigInt(1) })),
      unreadable("child"),
    );
  });
});

describe("checkIpcStream: the stream apache-arrow 21.2.0 walks is the stream checked", () => {
  test("a schema message with a body, which apache-arrow would read as the next message", () => {
    refusedWith(
      () => checkIpcStream(join(handMessage(1, BigInt(8)), new Uint8Array(8), END)),
      unreadable("schemaBody"),
    );
  });

  test("a batch older than metadata version V4, whose buffers apache-arrow reads at other positions", () => {
    const stream = int64Batch(0, 4);
    const { view, batchMessage } = tablesOf(stream);
    view.setInt16(slotAt(view, batchMessage, 0), 2, true); // V3
    refusedWith(() => checkIpcStream(stream), unreadable("version"));
    view.setInt16(slotAt(view, batchMessage, 0), 3, true); // V4
    expect(checkIpcStream(stream)).toStrictEqual({ fields: 1, depth: 1, batches: 1 });
  });

  test("a field whose children do not match its type: a list of two children, a list of none, a string with one", () => {
    const pair = columnsStream([
      {
        name: "x",
        kind: "struct",
        length: 1,
        children: [
          { name: "y", kind: "int32", values: [7] },
          { name: "z", kind: "int32", values: [8] },
        ],
      },
      { name: "c", kind: "utf8", values: ["spark"] },
    ]);
    // The same nodes and buffers in the same order as a list of y, then z and c at the top.
    const listThenTwo = columnsStream([
      { name: "x", kind: "list", offsets: [0, 1], child: { name: "y", kind: "int32", values: [7] } },
      { name: "z", kind: "int32", values: [8] },
      { name: "c", kind: "utf8", values: ["spark"] },
    ]);
    refusedWith(() => checkIpcStream(splice(retyped(pair, 0, 12), listThenTwo)), unreadable("type"));
    refusedWith(
      () => checkIpcStream(retyped(columnsStream([{ name: "x", kind: "int32", values: [0] }]), 0, 12)),
      unreadable("type"),
    );
    const single = columnsStream([
      { name: "x", kind: "struct", length: 1, children: [{ name: "y", kind: "int32", values: [1] }] },
    ]);
    const stringThenInt = columnsStream([
      { name: "x", kind: "utf8", values: ["ab"] },
      { name: "y", kind: "int32", values: [1] },
    ]);
    refusedWith(() => checkIpcStream(splice(retyped(single, 0, 5), stringThenInt)), unreadable("type"));
  });

  test("a map whose child is not one struct of a key and a value, which apache-arrow reads but Studio cannot", () => {
    const entries = (count: number): SparkIpcColumn => ({
      name: "entries",
      kind: "struct",
      length: 1,
      children: Array.from({ length: count }, (_, index) => ({ name: `f${index}`, kind: "utf8", values: ["k"] })),
    });
    const listOf = (child: SparkIpcColumn) => columnsStream([{ name: "m", kind: "list", offsets: [0, 1], child }]);
    // Lists retyped to maps (Schema.fbs: Map 17): of a string, then of structs of one field and of three.
    refusedWith(
      () => checkIpcStream(retyped(listOf({ name: "e", kind: "utf8", values: ["a"] }), 0, 17)),
      unreadable("type"),
    );
    refusedWith(() => checkIpcStream(retyped(listOf(entries(1)), 0, 17)), unreadable("type"));
    refusedWith(() => checkIpcStream(retyped(listOf(entries(3)), 0, 17)), unreadable("type"));
    // A struct of two key-value structs retyped to a map: a map keeps one child.
    const pair = columnsStream([{ name: "m", kind: "struct", length: 1, children: [entries(2), entries(2)] }]);
    refusedWith(() => checkIpcStream(retyped(pair, 0, 17)), unreadable("type"));
    expect(checkIpcStream(mapStream())).toStrictEqual({ fields: 4, depth: 3, batches: 1 });
  });

  test("a map's type table, whose keysSorted apache-arrow reads: absent, or past the end of the header", () => {
    const mapWith = (patch: (view: DataView, field: number) => void) => {
      const stream = mapStream();
      const { view, field } = tablesOf(stream);
      patch(view, field(0));
      return stream;
    };
    // Field slot 3, the type, cleared in the field's vtable: apache-arrow then calls keysSorted on null.
    const absent = mapWith((view, field) => view.setUint16(field - view.getInt32(field, true) + 4 + 2 * 3, 0, true));
    refusedWith(() => checkIpcStream(absent), unreadable("header"));
    // The type pointed 64 KiB on, past the end of the header and of the stream.
    const outside = mapWith((view, field) => view.setUint32(slotAt(view, field, 3), 0x10000, true));
    refusedWith(() => checkIpcStream(outside), unreadable("header"));
  });

  test("variadic buffer counts, which only a view column has: one apache-arrow cannot convert, and any other", () => {
    expect(checkIpcStream(variadicStream(undefined))).toStrictEqual({ fields: 0, depth: 0, batches: 1 });
    expect(checkIpcStream(variadicStream([]))).toStrictEqual({ fields: 0, depth: 0, batches: 1 });
    // 2^60 is past 2^53: apache-arrow throws converting it to a number.
    refusedWith(() => checkIpcStream(variadicStream([BigInt(2 ** 60)])), unreadable("nodes"));
    refusedWith(() => checkIpcStream(variadicStream([BigInt(1)])), unreadable("nodes"));
  });

  test("a batch row count below 0 or past 2^31 - 1, even with no columns", () => {
    const noNodes = patchRecordBatch(patchRecordBatch(int64Batch(0, 4), { kind: "node-count", count: 0 }), {
      kind: "buffer-count",
      count: 0,
    });
    const stream = splice(columnsStream([]), noNodes);
    expect(checkIpcStream(stream, 4)).toStrictEqual({ fields: 0, depth: 0, batches: 1 });
    const { view, batch } = tablesOf(stream);
    view.setBigInt64(slotAt(view, batch, 0), BigInt(-1), true);
    refusedWith(() => checkIpcStream(stream), unreadable("length"));
    view.setBigInt64(slotAt(view, batch, 0), BigInt(2 ** 31), true);
    refusedWith(() => checkIpcStream(stream), unreadable("length"));
  });

  test("a buffer not aligned to 8 bytes, which apache-arrow cannot view as a typed array", () => {
    // A validity buffer of 8 bytes at 0 and the values, 32 bytes, at 8: moved to 4, they stay inside the body.
    const stream = columnsStream([{ name: "id", kind: "int64", values: [BigInt(1), null, BigInt(3), BigInt(4)] }]);
    refusedWith(
      () => checkIpcStream(patchRecordBatch(stream, { kind: "buffer", index: 1, offset: BigInt(4) })),
      unreadable("alignment"),
    );
  });

  test("a vtable read as flatbuffers reads it: a negative size or offset, and a slot that starts inside an odd size", () => {
    const negativeSize = handMessage(1, BigInt(0));
    new DataView(negativeSize.buffer).setUint16(8 + 4, 0x8000 + 12, true);
    refusedWith(() => checkIpcStream(join(negativeSize, END)), unreadable("header"));
    const negativeOffset = handMessage(1, BigInt(0));
    new DataView(negativeOffset.buffer).setUint16(8 + 14, 0x8000 + 4, true);
    refusedWith(() => checkIpcStream(join(negativeOffset, END)), unreadable("header"));
    // A vtable of 11 bytes still holds slot 3 (bodyLength) for flatbuffers, which starts at byte 10.
    const oddSize = handMessage(1, BigInt(8));
    new DataView(oddSize.buffer).setUint16(8 + 4, 11, true);
    refusedWith(() => checkIpcStream(join(oddSize, new Uint8Array(8), END)), unreadable("schemaBody"));
  });

  test("names and metadata a header holds once are read, and the same bytes held twice are refused", () => {
    const columns = (count: number) =>
      columnsStream(
        Array.from({ length: count }, (_, index) => ({
          name: index === 0 ? "x".repeat(400) : `c${index}`,
          metadata: { key: index === 0 ? "v".repeat(400) : "w" },
          kind: "int32" as const,
          values: [index],
        })),
      );
    expect(checkIpcStream(columns(3))).toStrictEqual({ fields: 3, depth: 1, batches: 1 });
    for (const slot of [0, 6]) {
      // Field slot 0 is the name and slot 6 the custom metadata; fields 1 and 2 are made to point at field 0's.
      const stream = columns(3);
      const { view, field } = tablesOf(stream);
      const first = tableAt(view, slotAt(view, field(0), slot));
      for (const index of [1, 2]) {
        const at = slotAt(view, field(index), slot);
        view.setUint32(at, first - at, true);
      }
      refusedWith(() => checkIpcStream(stream), unreadable("overlap"));
    }
  });
});

describe("checkIpcStream: the check reads each body byte at most once", () => {
  test("a buffer that starts before the previous one ends: shared offsets, data inside offsets, buffers out of order", () => {
    // Two Utf8 columns of the same values: validity, offsets and data of a (buffers 0 to 2), then of b (3 to 5).
    const stream = columnsStream([
      { name: "a", kind: "utf8", values: ["ab", "cd"] },
      { name: "b", kind: "utf8", values: ["ab", "cd"] },
    ]);
    expect(checkIpcStream(stream)).toStrictEqual({ fields: 2, depth: 1, batches: 1 });
    const { view, batch } = tablesOf(stream);
    const buffers = tableAt(view, slotAt(view, batch, 2)) + 4;
    const offsetOf = (index: number) => view.getBigInt64(buffers + 16 * index, true);
    const endOf = (index: number) => offsetOf(index) + view.getBigInt64(buffers + 16 * index + 8, true);
    // b's offsets moved onto a's: inside the body and aligned, the same bytes the offsets check of a reads.
    refusedWith(
      () => checkIpcStream(patchRecordBatch(stream, { kind: "buffer", index: 4, offset: offsetOf(1) })),
      unreadable("bufferOrder"),
    );
    // b's data moved 8 bytes into b's offsets buffer, recorded as 16 bytes: after its start, before its end.
    refusedWith(
      () => checkIpcStream(patchRecordBatch(stream, { kind: "buffer", index: 5, offset: offsetOf(4) + BigInt(8) })),
      unreadable("bufferOrder"),
    );
    // a's empty validity buffer moved to where the last buffer ends: no bytes overlap, but the order is broken.
    refusedWith(
      () => checkIpcStream(patchRecordBatch(stream, { kind: "buffer", index: 0, offset: endOf(5) })),
      unreadable("bufferOrder"),
    );
  });
});
