/**
 * Reading one ExecutePlan stream over a stub stream whose responses have the shape the
 * Spark descriptor decodes them to (SPARK_LOADER_OPTIONS: an unset message field outside the response_type oneof is
 * null, an int64 is a decimal string): response kinds, chunk reassembly and its refusals, the row and byte budgets with
 * a result that ends exactly on one, stream.truncated read after every undefined, the 32 MiB batch check and
 * batch-too-large, and the cost rule at 8 bytes a value plus the fixed overhead each kept batch pays.
 *
 * The reader holds a batch's declared row count twice: against the stream before apache-arrow reads it, and against
 * what the Arrow reader decoded. The two agree for every stream the pre-check passes, so the Arrow reader is replaced,
 * for this file alone (the runner gives each file its own process), by the real one recorded, whose row count a test
 * can change: one test sees that a disagreeing batch is never decoded, another that a decoded count is held too.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  SPARK_ARROW_CHUNK_BYTES,
  SPARK_BATCH_OVERHEAD_BYTES,
  SPARK_RESULT_BYTE_BUDGET,
  SPARK_STREAM_MAX_RECEIVED_BYTES,
} from "@/lib/db/providers/sql/spark/constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import type { SparkPlanStream } from "@/lib/db/providers/sql/spark/grpc-client";
import { SPARK_IPC_FAILURES } from "@/lib/db/providers/sql/spark/ipc-guard";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { columnsStream, int64Batch, largeUtf8Stream, patchRecordBatch, stringBatch } from "../../../helpers/spark-ipc";

const realArrow = { ...(await import("@/lib/db/providers/sql/spark/arrow")) };
const { readIpcColumns } = realArrow;
/** Every stream the reader handed the Arrow reader. */
const decoded: Uint8Array[] = [];
/** While set, the row count the Arrow reader answers in place of the one it read. */
let decodedRowCount: number | undefined;
mock.module("@/lib/db/providers/sql/spark/arrow", () => ({
  ...realArrow,
  readIpcColumns(bytes: Uint8Array) {
    decoded.push(bytes);
    const columns = realArrow.readIpcColumns(bytes);
    return decodedRowCount === undefined ? columns : { ...columns, rowCount: decodedRowCount };
  },
}));

const { keepRows, readCommandAnswer, readRelationAnswer, SPARK_CUT_WARNINGS } = await import(
  "@/lib/db/providers/sql/spark/result-stream"
);

const MiB = 1_048_576;
const INT32_MAX = 2 ** 31 - 1;
const WIDE = { rows: 1_000_000_000, bytes: 1_000_000_000 };
const BUDGET = { rows: MAX_UNLIMITED_ROWS, bytes: SPARK_RESULT_BYTE_BUDGET };

/** A response as the descriptor decodes one: `schema` and `metrics` lie outside the oneof, so unset they are null. */
const response = (fields: object): object => ({
  session_id: "session",
  operation_id: "operation",
  schema: null,
  metrics: null,
  observed_metrics: [],
  ...fields,
});
const DATA_TYPE = { struct: { fields: [{ name: "id", data_type: { long: {} }, nullable: true }] } };
const SCHEMA = response({ schema: DATA_TYPE });
const METRICS = response({ metrics: { metrics: [] } });
const PROGRESS = response({ execution_progress: { stages: [] }, response_type: "execution_progress" });
const command = (relation: object | null) =>
  response({ sql_command_result: { relation }, response_type: "sql_command_result" });
const batch = (ipc: Uint8Array, rows: number) =>
  response({ arrow_batch: { row_count: String(rows), data: ipc }, response_type: "arrow_batch" });

/** `ipc` cut into `count` consecutive chunks of one batch, each declaring `declared` chunks, as Spark sends them. */
function chunks(ipc: Uint8Array, rows: number, count: number, declared = count): object[] {
  return Array.from({ length: count }, (_, index) =>
    response({
      arrow_batch: {
        row_count: String(rows),
        data: ipc.subarray(Math.floor((index * ipc.length) / count), Math.floor(((index + 1) * ipc.length) / count)),
        chunk_index: String(index),
        num_chunks_in_batch: String(declared),
        start_offset: "0",
      },
      response_type: "arrow_batch",
    }),
  );
}

interface Stub extends SparkPlanStream {
  readonly cancelled: () => boolean;
  /** How many responses the reader took. */
  readonly taken: () => number;
}

/**
 * A stream answering `responses` in order, then the server's end. `truncateAt` ends it after that many responses as
 * the 32 MiB bound would; `bytes` gives each response's received size (1 by default). `bound` ends it as the channel
 * does: bytes are counted as each response is taken, and the response that reaches the bound is still handed over,
 * the stream already truncated, with nothing after it.
 */
function stub(
  responses: readonly object[],
  options: {
    readonly truncateAt?: number;
    readonly bytes?: (index: number) => number;
    readonly bound?: number;
  } = {},
): Stub {
  let index = 0;
  let received = 0;
  let truncated = false;
  let cancelled = false;
  return {
    async read() {
      if (cancelled || truncated) return undefined;
      if (options.truncateAt !== undefined && index >= options.truncateAt) {
        truncated = true;
        return undefined;
      }
      const next = responses[index];
      if (next === undefined) return undefined;
      received += options.bytes?.(index) ?? 1;
      index += 1;
      if (options.bound !== undefined && received >= options.bound) truncated = true;
      return next;
    },
    get receivedBytes() {
      return received;
    },
    get truncated() {
      return truncated || cancelled;
    },
    cancel() {
      cancelled = true;
    },
    cancelled: () => cancelled,
    taken: () => index,
  };
}

async function refusal(promise: Promise<unknown>): Promise<SparkError> {
  return promise.then(
    () => {
      throw new Error("the read answered, though this test expects a refusal");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(SparkError);
      return error as SparkError;
    },
  );
}

/** The read is refused as unreadable, its sentence naming `what`. */
async function expectUnreadable(promise: Promise<unknown>, what: string): Promise<void> {
  const error = await refusal(promise);
  expect([error.category, error.message]).toStrictEqual(["unreadable", SPARK_ERROR_SENTENCES.unreadable(what)]);
}

const keptRows = (answer: { readonly batches: readonly { readonly rows: number }[] }) =>
  answer.batches.reduce((sum, kept) => sum + kept.rows, 0);

describe("readCommandAnswer", () => {
  test("reads past progress and metrics to the end and answers the first command result's relation", async () => {
    const relation = { sql: { query: "SELECT 1" } };
    const stream = stub([PROGRESS, command(relation), command({ sql: { query: "SELECT 2" } }), METRICS]);
    const answer = await readCommandAnswer(stream);
    expect(answer).toStrictEqual({ relation });
    expect(answer.relation).toBe(relation);
    expect(stream.taken()).toBe(4);
    expect(stream.cancelled()).toBe(false);
  });

  test("a stream with no command result, or a command result without a relation, is unreadable", async () => {
    await expectUnreadable(readCommandAnswer(stub([PROGRESS, METRICS])), "the command answered no result");
    await expectUnreadable(
      readCommandAnswer(stub([PROGRESS, command(null), METRICS])),
      "the command result held no relation",
    );
  });

  test("a stream the 32 MiB bound truncated is unreadable, even after its command result", async () => {
    await expectUnreadable(readCommandAnswer(stub([PROGRESS], { truncateAt: 1 })), "the command answer passed 32 MiB");
    await expectUnreadable(
      readCommandAnswer(stub([command({ sql: { query: "SELECT 1" } }), METRICS], { truncateAt: 1 })),
      "the command answer passed 32 MiB",
    );
  });
});

test("a failed read rejects with the stream's own error, unchanged, for execute.ts to map", async () => {
  const failure = new Error("the call failed");
  const failing: SparkPlanStream = {
    read: () => Promise.reject(failure),
    receivedBytes: 0,
    truncated: false,
    cancel() {},
  };
  await expect(readCommandAnswer(failing)).rejects.toBe(failure);
  await expect(readRelationAnswer(failing, WIDE)).rejects.toBe(failure);
});

describe("readRelationAnswer: kinds and reassembly", () => {
  test("the schema, whole batches, progress and metrics", async () => {
    const stream = stub([SCHEMA, PROGRESS, batch(int64Batch(0, 3), 3), PROGRESS, batch(int64Batch(3, 2), 2), METRICS]);
    const answer = await readRelationAnswer(stream, WIDE);
    expect(answer.schema).toBe(DATA_TYPE);
    expect(answer.batches.map((kept) => [kept.rows, kept.columns.rowCount])).toStrictEqual([
      [3, 3],
      [2, 2],
    ]);
    expect(answer.batches[1]?.columns).toStrictEqual(readIpcColumns(int64Batch(3, 2)));
    expect(answer.cut).toBeNull();
    expect(stream.cancelled()).toBe(false);
  });

  test("an answer without a schema response answers none, and a batch of no rows keeps nothing", async () => {
    const answer = await readRelationAnswer(
      stub([batch(int64Batch(0, 0), 0), batch(int64Batch(0, 1), 1), METRICS]),
      WIDE,
    );
    expect(answer.schema).toBeUndefined();
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([1]);
    expect(answer.cut).toBeNull();
  });

  test("a chunked batch is reassembled in order into the bytes of the whole stream, and a batch of one chunk follows", async () => {
    const ipc = stringBatch(50, 100);
    decoded.length = 0;
    const answer = await readRelationAnswer(
      stub([SCHEMA, ...chunks(ipc, 50, 3), ...chunks(stringBatch(5, 10), 5, 1), METRICS]),
      WIDE,
    );
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([50, 5]);
    expect(Buffer.compare(decoded[0] as Uint8Array, ipc)).toBe(0);
    expect(answer.batches[0]?.columns).toStrictEqual(readIpcColumns(ipc));
    expect(answer.cut).toBeNull();
  });

  test("chunk fields that are unset, absent or null, read as one chunk of one", async () => {
    const answer = await readRelationAnswer(
      stub([
        SCHEMA,
        response({
          arrow_batch: { row_count: "1", data: int64Batch(0, 1), chunk_index: null, num_chunks_in_batch: null },
        }),
        response({ arrow_batch: { row_count: "2", data: int64Batch(1, 2) } }),
        METRICS,
      ]),
      WIDE,
    );
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([1, 2]);
  });

  const [P0, P1, P2] = chunks(stringBatch(50, 100), 50, 3) as [object, object, object];
  const ENDED = "a chunked batch that ended before its last chunk";
  const ORDER = "a chunk out of order or repeated";
  const DIFFERS = "a chunk whose chunk count or row count differs from its batch's first chunk";
  test.each([
    ["a gap", [P0, P2], ORDER],
    ["a later chunk repeated", [P0, P1, P1, P2], ORDER],
    ["a chunk before its batch's first chunk", [P1, P2], ORDER],
    ["the first chunk repeated", [P0, P0, P1, P2], ENDED],
    ["a new batch before the last one completed", [P0, P1, ...chunks(int64Batch(0, 1), 1, 1)], ENDED],
    ["a stream that ends before the last chunk", [P0, P1], ENDED],
    ["a chunk count that changes", [P0, ...chunks(stringBatch(50, 100), 50, 3, 4).slice(1)], DIFFERS],
    ["a row count that changes", [P0, ...chunks(stringBatch(50, 100), 49, 3).slice(1)], DIFFERS],
  ] as const)("%s is refused as unreadable", async (_name, shape, what) => {
    await expectUnreadable(readRelationAnswer(stub([SCHEMA, ...shape]), WIDE), what);
  });

  const ROW_COUNT = "a batch whose row count is not a whole number";
  const INDEX = "a chunk whose index is not a whole number";
  const COUNT = "a batch whose chunk count is not a whole number of at least 1";
  test.each([
    ["a row count below zero", { row_count: "-1" }, ROW_COUNT],
    ["a fractional row count", { row_count: "1.5" }, ROW_COUNT],
    ["a row count past 2^53", { row_count: "9007199254740993" }, ROW_COUNT],
    ["a row count that is a number, not the decimal string the loader writes", { row_count: 1 }, ROW_COUNT],
    ["no row count", { row_count: undefined }, ROW_COUNT],
    ["a chunk index below zero", { chunk_index: "-1", num_chunks_in_batch: "1" }, INDEX],
    ["a chunk index in hexadecimal", { chunk_index: "0x0", num_chunks_in_batch: "1" }, INDEX],
    ["a chunk count of zero", { chunk_index: "0", num_chunks_in_batch: "0" }, COUNT],
    ["a chunk count in words", { chunk_index: "0", num_chunks_in_batch: "two" }, COUNT],
  ] as const)("%s is refused as unreadable", async (_name, fields, what) => {
    const arrow = { row_count: "1", data: int64Batch(0, 1), ...fields };
    await expectUnreadable(readRelationAnswer(stub([SCHEMA, response({ arrow_batch: arrow })]), WIDE), what);
  });

  test.each([
    ["a batch without data", { row_count: "1" }],
    ["a batch whose data is not bytes", { row_count: "1", data: "AAAA" }],
  ] as const)("%s is refused as unreadable", async (_name, arrow) => {
    await expectUnreadable(
      readRelationAnswer(stub([SCHEMA, response({ arrow_batch: arrow })]), WIDE),
      "a batch without data",
    );
  });

  test("a row count that disagrees with the batch is refused before the Arrow reader decodes it", async () => {
    decoded.length = 0;
    await expectUnreadable(
      readRelationAnswer(stub([SCHEMA, batch(int64Batch(0, 3), 4)]), WIDE),
      SPARK_IPC_FAILURES.rowCount,
    );
    expect(decoded).toHaveLength(0);
  });

  test("a decoded row count other than the declared one is refused too", async () => {
    decodedRowCount = 2;
    try {
      await expectUnreadable(
        readRelationAnswer(stub([SCHEMA, batch(int64Batch(0, 3), 3)]), WIDE),
        SPARK_IPC_FAILURES.rowCount,
      );
    } finally {
      decodedRowCount = undefined;
    }
  });

  test("the stream check refuses a large string type before the batch is read", async () => {
    decoded.length = 0;
    const error = await refusal(readRelationAnswer(stub([SCHEMA, batch(largeUtf8Stream(), 1)]), WIDE));
    expect([error.category, error.message]).toStrictEqual(["unreadable", SPARK_ERROR_SENTENCES.largeVarTypes]);
    expect(decoded).toHaveLength(0);
  });
});

describe("readRelationAnswer: budgets", () => {
  test("the row budget cuts inside a batch and cancels the stream; ending exactly on it is whole", async () => {
    const three = [
      SCHEMA,
      batch(int64Batch(0, 1_000), 1_000),
      batch(int64Batch(1_000, 1_000), 1_000),
      batch(int64Batch(2_000, 1_000), 1_000),
      METRICS,
    ];
    const stream = stub(three);
    const cut = await readRelationAnswer(stream, { rows: 2_500, bytes: WIDE.bytes });
    expect(cut.cut).toBe("rows");
    expect(cut.batches.map((kept) => kept.rows)).toStrictEqual([1_000, 1_000, 500]);
    expect(stream.cancelled()).toBe(true);
    const exactStream = stub(three);
    const exact = await readRelationAnswer(exactStream, { rows: 3_000, bytes: WIDE.bytes });
    expect(exact.cut).toBeNull();
    expect(keptRows(exact)).toBe(3_000);
    expect(exactStream.cancelled()).toBe(false);
    // The budget is spent at a batch boundary and a row remains: the cut, with no batch for the refused rows.
    const atBoundary = await readRelationAnswer(stub(three), { rows: 2_000, bytes: WIDE.bytes });
    expect(atBoundary.cut).toBe("rows");
    expect(atBoundary.batches.map((kept) => kept.rows)).toStrictEqual([1_000, 1_000]);
  });

  test("the byte budget cuts before the row that would pass it and cancels the stream", async () => {
    // stringBatch writes exactly `width` ASCII characters a value, so a row costs 8 + 100, and the batch
    // pays its overhead once.
    const stream = stub([SCHEMA, batch(stringBatch(10, 100), 10), METRICS]);
    const answer = await readRelationAnswer(stream, {
      rows: WIDE.rows,
      bytes: SPARK_BATCH_OVERHEAD_BYTES + 3 * 108 + 50,
    });
    expect(answer.cut).toBe("bytes");
    expect(keptRows(answer)).toBe(3);
    expect(stream.cancelled()).toBe(true);
  });

  test("keepRows: 8 bytes a value for empty strings and for nulls, and exactly the budget keeps every row", () => {
    const OVERHEAD = SPARK_BATCH_OVERHEAD_BYTES;
    const empty = readIpcColumns(stringBatch(10, 0));
    expect(keepRows(empty, { rows: 100, bytes: OVERHEAD + 80 }, { rows: 0, bytes: 0 })).toStrictEqual({
      rows: 10,
      cut: null,
    });
    expect(keepRows(empty, { rows: 100, bytes: OVERHEAD + 79 }, { rows: 0, bytes: 0 })).toStrictEqual({
      rows: 9,
      cut: "bytes",
    });
    const nulls = readIpcColumns(
      columnsStream([
        { name: "n", kind: "null", length: 10 },
        { name: "s", kind: "utf8", values: Array.from({ length: 10 }, () => null) },
      ]),
    );
    expect(keepRows(nulls, { rows: 100, bytes: OVERHEAD + 160 }, { rows: 0, bytes: 0 })).toStrictEqual({
      rows: 10,
      cut: null,
    });
    expect(keepRows(nulls, { rows: 100, bytes: OVERHEAD + 159 }, { rows: 0, bytes: 0 })).toStrictEqual({
      rows: 9,
      cut: "bytes",
    });
    // keepRows advances what the statement has kept, so the next batch starts where this one stopped.
    const used = { rows: 95, bytes: 0 };
    expect(keepRows(empty, { rows: 100, bytes: OVERHEAD + 1_000 }, used)).toStrictEqual({ rows: 5, cut: "rows" });
    expect(used).toStrictEqual({ rows: 100, bytes: OVERHEAD + 40 });
    // A row both budgets refuse is cut by the row budget; a batch with no row declares no cut, even on a spent budget.
    expect(keepRows(empty, { rows: 5, bytes: OVERHEAD + 40 }, { rows: 0, bytes: 0 })).toStrictEqual({
      rows: 5,
      cut: "rows",
    });
    const none = readIpcColumns(int64Batch(0, 0));
    expect(keepRows(none, { rows: 0, bytes: 0 }, { rows: 0, bytes: 0 })).toStrictEqual({ rows: 0, cut: null });
  });

  test("keepRows charges a batch its overhead once, with its first row kept, and a batch that keeps no row nothing", () => {
    // 1,000 Int64 values cost 8,000; the batch adds exactly SPARK_BATCH_OVERHEAD_BYTES to that, once a batch.
    const thousand = readIpcColumns(int64Batch(0, 1_000));
    const used = { rows: 0, bytes: 0 };
    const whole = { rows: WIDE.rows, bytes: 2 * (SPARK_BATCH_OVERHEAD_BYTES + 8_000) };
    expect(keepRows(thousand, whole, used)).toStrictEqual({ rows: 1_000, cut: null });
    expect(used).toStrictEqual({ rows: 1_000, bytes: SPARK_BATCH_OVERHEAD_BYTES + 8_000 });
    expect(keepRows(thousand, whole, used)).toStrictEqual({ rows: 1_000, cut: null });
    expect(used).toStrictEqual({ rows: 2_000, bytes: 2 * (SPARK_BATCH_OVERHEAD_BYTES + 8_000) });
    const short = { rows: WIDE.rows, bytes: SPARK_BATCH_OVERHEAD_BYTES + 7_999 };
    expect(keepRows(thousand, short, { rows: 0, bytes: 0 })).toStrictEqual({ rows: 999, cut: "bytes" });
    // A first row that cannot pay the overhead with its own cost is refused, and the batch is charged nothing.
    const unpaid = { rows: 0, bytes: 0 };
    const tight = { rows: WIDE.rows, bytes: SPARK_BATCH_OVERHEAD_BYTES + 7 };
    expect(keepRows(thousand, tight, unpaid)).toStrictEqual({ rows: 0, cut: "bytes" });
    expect(unpaid).toStrictEqual({ rows: 0, bytes: 0 });
  });

  test("many one-row batches are cut by the byte budget at the batch count the overhead predicts", async () => {
    // The shape of a statement over very many tiny partitions: each kept batch costs its 8-byte value and its
    // overhead, so a budget of 64 KiB keeps 65,536 / (1,024 + 8) rounded down, 63 batches, not all 100.
    const stream = stub([SCHEMA, ...Array.from({ length: 100 }, (_, row) => batch(int64Batch(row, 1), 1)), METRICS]);
    const answer = await readRelationAnswer(stream, { rows: WIDE.rows, bytes: 65_536 });
    expect(answer.cut).toBe("bytes");
    expect(answer.batches).toHaveLength(63);
    expect(answer.batches.every((kept) => kept.rows === 1)).toBe(true);
    expect(stream.taken()).toBe(65);
    expect(stream.cancelled()).toBe(true);
  });

  test("a list cell over a Null child of 2^31 - 1 values is cut by the byte budget before its array is built", async () => {
    // Written with a child of 2 values, then the child's length and the last offset patched: no test writes 2^31 values.
    const written = columnsStream([
      { name: "l", kind: "list", offsets: [0, 1, 2], child: { name: "element", kind: "null", length: 2 } },
    ]);
    const long = patchRecordBatch(written, {
      kind: "node",
      index: 1,
      length: BigInt(INT32_MAX),
      nullCount: BigInt(INT32_MAX),
    });
    const ipc = patchRecordBatch(long, { kind: "int32", buffer: 1, at: 2, value: INT32_MAX });
    const stream = stub([SCHEMA, batch(ipc, 2), METRICS]);
    const answer = await readRelationAnswer(stream, BUDGET);
    // Row 0 holds one null and costs 16; row 1 holds 2^31 - 2 of them, 8 + 8 x (2^31 - 2) by its offsets alone.
    expect(answer.cut).toBe("bytes");
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([1]);
    expect(answer.batches[0]?.columns.columns[0]?.children[0]?.length).toBe(INT32_MAX);
    expect(stream.cancelled()).toBe(true);
  });
});

describe("readRelationAnswer: the 32 MiB bound", () => {
  const [P0, P1] = chunks(stringBatch(50, 100), 50, 3) as [object, object, object];

  test("truncated after complete batches is the cut stream, the incomplete sequence dropped", async () => {
    const stream = stub([SCHEMA, batch(int64Batch(0, 5), 5), P0, P1], { truncateAt: 4 });
    const answer = await readRelationAnswer(stream, WIDE);
    expect(answer.cut).toBe("stream");
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([5]);
    expect(stream.cancelled()).toBe(true);
  });

  test("truncated on a batch boundary is the cut stream with every batch before it", async () => {
    const answer = await readRelationAnswer(
      stub([SCHEMA, batch(int64Batch(0, 5), 5), batch(int64Batch(5, 5), 5), METRICS], { truncateAt: 3 }),
      WIDE,
    );
    expect(answer.cut).toBe("stream");
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([5, 5]);
  });

  test("truncated before any batch completed is batch-too-large with the MiB received, rounded, at least 1", async () => {
    // 20 MiB received with the first chunk passes the batch check (20 + 2 x 4 < 32), and the bound then ends the stream.
    const truncated = stub([SCHEMA, P0], { truncateAt: 2, bytes: (index) => (index === 0 ? 1 : 20 * MiB) });
    const error = await refusal(readRelationAnswer(truncated, WIDE));
    expect([error.category, error.message]).toStrictEqual(["batch-too-large", SPARK_ERROR_SENTENCES.batchTooLarge(20)]);
    expect(truncated.cancelled()).toBe(true);
    const upward = await refusal(
      readRelationAnswer(
        stub([SCHEMA, P0], { truncateAt: 2, bytes: (index) => (index === 0 ? 1 : Math.round(20.7 * MiB)) }),
        WIDE,
      ),
    );
    expect(upward.message).toBe(SPARK_ERROR_SENTENCES.batchTooLarge(21));
    const few = await refusal(readRelationAnswer(stub([SCHEMA, P0], { truncateAt: 2 }), WIDE));
    expect([few.category, few.message]).toStrictEqual(["batch-too-large", SPARK_ERROR_SENTENCES.batchTooLarge(1)]);
  });

  test("an undefined after the metrics response is the whole answer, not a cut", async () => {
    const answer = await readRelationAnswer(
      stub([SCHEMA, batch(int64Batch(0, 2), 2), METRICS], { truncateAt: 3 }),
      WIDE,
    );
    expect(answer.cut).toBeNull();
    expect(keptRows(answer)).toBe(2);
  });

  test("metrics followed by a batch no longer mark the answer whole: the bound after it is the cut stream", async () => {
    const answer = await readRelationAnswer(
      stub([SCHEMA, METRICS, batch(int64Batch(0, 2), 2)], { truncateAt: 3 }),
      WIDE,
    );
    expect(answer.cut).toBe("stream");
    expect(keptRows(answer)).toBe(2);
  });

  test("an incomplete chunk sequence before the metrics response is unreadable, the bound reached or not", async () => {
    await expectUnreadable(
      readRelationAnswer(stub([SCHEMA, P0, METRICS], { truncateAt: 3 }), WIDE),
      "a chunked batch that ended before its last chunk",
    );
  });

  test("a first chunk whose batch cannot fit stops the read there: batch-too-large, or the cut after a kept batch", async () => {
    const big = (rows: number) =>
      response({
        arrow_batch: {
          row_count: String(rows),
          data: new Uint8Array(8),
          chunk_index: "0",
          num_chunks_in_batch: "8",
          start_offset: "0",
        },
      });
    const first = stub([SCHEMA, big(1), PROGRESS], { bytes: (index) => (index === 1 ? 4 * MiB : 10) });
    const error = await refusal(readRelationAnswer(first, WIDE));
    expect([error.category, error.message]).toStrictEqual(["batch-too-large", SPARK_ERROR_SENTENCES.batchTooLarge(32)]);
    expect(first.cancelled()).toBe(true);
    expect(first.taken()).toBe(2);
    const later = stub([SCHEMA, batch(int64Batch(0, 4), 4), big(1), PROGRESS], {
      bytes: (index) => (index === 2 ? 4 * MiB : 10),
    });
    const answer = await readRelationAnswer(later, WIDE);
    expect(answer.cut).toBe("stream");
    expect(keptRows(answer)).toBe(4);
    expect(later.cancelled()).toBe(true);
    expect(later.taken()).toBe(3);
  });

  test("the batch check reads a batch whose chunks stay below the bound and stops one that would reach it", async () => {
    const ipc = stringBatch(50, 100);
    // What may be received with the first of 8 chunks: the other 7 can each be a whole preferred chunk.
    const room = SPARK_STREAM_MAX_RECEIVED_BYTES - 7 * SPARK_ARROW_CHUNK_BYTES;
    const below = await readRelationAnswer(
      stub([SCHEMA, ...chunks(ipc, 50, 8), METRICS], { bytes: (index) => (index === 1 ? room - 2 : 1) }),
      WIDE,
    );
    expect(below.cut).toBeNull();
    expect(keptRows(below)).toBe(50);
    const at = stub([SCHEMA, ...chunks(ipc, 50, 8), METRICS], { bytes: (index) => (index === 1 ? room - 1 : 1) });
    const error = await refusal(readRelationAnswer(at, WIDE));
    expect([error.category, error.message]).toStrictEqual(["batch-too-large", SPARK_ERROR_SENTENCES.batchTooLarge(32)]);
    expect(at.taken()).toBe(2);
  });

  test("a one-chunk batch whose bytes reach the bound is whole when read: it is kept, with the cut stream", async () => {
    // As Spark sends them, every batch one chunk (num_chunks_in_batch "1"), and 1 MiB a response: the schema and 30
    // batches leave 31 MiB counted, and the 31st batch is the response that reaches the bound.
    const ones = Array.from({ length: 40 }, (_, at) => chunks(int64Batch(at * 5, 5), 5, 1)[0] as object);
    const stream = stub([SCHEMA, ...ones, METRICS], { bound: SPARK_STREAM_MAX_RECEIVED_BYTES, bytes: () => MiB });
    const answer = await readRelationAnswer(stream, WIDE);
    expect(answer.cut).toBe("stream");
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual(Array.from({ length: 31 }, () => 5));
    expect(stream.receivedBytes).toBe(SPARK_STREAM_MAX_RECEIVED_BYTES);
    expect(stream.taken()).toBe(32);
    expect(stream.cancelled()).toBe(true);
  });

  test("a batch with chunks still to come is still checked at its first chunk under the same counting", async () => {
    // With its first chunk counted, the other two of three chunks could reach the bound: the cut is declared before it.
    const ipc = stringBatch(50, 100);
    const first = SPARK_STREAM_MAX_RECEIVED_BYTES - 2 * SPARK_ARROW_CHUNK_BYTES - 2;
    const stream = stub([SCHEMA, batch(int64Batch(0, 5), 5), ...chunks(ipc, 50, 3), METRICS], {
      bound: SPARK_STREAM_MAX_RECEIVED_BYTES,
      bytes: (index) => (index === 2 ? first : 1),
    });
    const answer = await readRelationAnswer(stream, WIDE);
    expect(answer.cut).toBe("stream");
    expect(answer.batches.map((kept) => kept.rows)).toStrictEqual([5]);
    expect(stream.taken()).toBe(3);
    expect(stream.cancelled()).toBe(true);
  });
});

test("the three cut warnings are fixed sentences, and their numbers are the budgets'", () => {
  expect(SPARK_CUT_WARNINGS).toStrictEqual({
    rows: "The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.",
    bytes: "The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown.",
    stream:
      "The result reached Studio's limit of 32 MiB received from Spark for one statement, so only the rows before it are shown.",
  });
  expect(Object.isFrozen(SPARK_CUT_WARNINGS)).toBe(true);
  expect(SPARK_CUT_WARNINGS.rows).toContain(`budget of ${MAX_UNLIMITED_ROWS.toLocaleString("en-US")} rows`);
  expect(SPARK_CUT_WARNINGS.bytes).toContain(`budget of ${SPARK_RESULT_BYTE_BUDGET / MiB} MiB`);
  expect(SPARK_CUT_WARNINGS.stream).toContain(`limit of ${SPARK_STREAM_MAX_RECEIVED_BYTES / MiB} MiB`);
});
