/**
 * The byte budgets, the row measure, the batch holder for rows already in memory and the result pump
 * (docs/providers/CONTRACT.md, clauses C-13, C-14 and C-15).
 *
 * The sources here are plain objects over arrays, honest (`rowsSource`) or scripted to answer what a source should not.
 * No test waits on a timer: every source answers at once, and a rejection is captured with a plain `await` in a `try`.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BATCH_MAX_BYTES,
  type BatchLimit,
  type CallRefusal,
  CallRefusalError,
  type Column,
  callRefusalSentence,
  encodedRowBytes,
  PAGE_ENDS,
  PAGE_MAX_BYTES,
  pumpPage,
  type ResultSource,
  type RowBatch,
  rowsSource,
} from "@libredb/provider-sdk/calls";
import { encodeValue, ValueCodecError } from "@libredb/provider-sdk/values";

const ONE: readonly Column[] = Object.freeze([{ name: "v" }]);
const TWO: readonly Column[] = Object.freeze([{ name: "a" }, { name: "b" }]);

/** A one-cell row whose encoded JSON text, `["..."]`, is exactly `bytes` long. */
function rowOf(bytes: number): unknown[] {
  return ["x".repeat(bytes - 4)];
}

/** What `pump` threw, or `undefined`; settled with a plain await, never after a timer. */
async function thrownBy(pump: () => Promise<unknown>): Promise<unknown> {
  try {
    await pump();
  } catch (error) {
    return error;
  }
  return undefined;
}

interface Scripted extends ResultSource {
  readonly limits: BatchLimit[];
  closes: number;
}

/** A source that answers `answer(n, limit)` to its `n`th pull, recording each limit and counting its closes. */
function scripted(
  columns: readonly Column[],
  answer: (pull: number, limit: BatchLimit) => unknown,
  close: () => Promise<void> = async () => {},
): Scripted {
  const source: Scripted = {
    columns,
    limits: [],
    closes: 0,
    async next(limit) {
      source.limits.push(limit);
      return answer(source.limits.length - 1, limit) as RowBatch;
    },
    async close() {
      source.closes += 1;
      await close();
    },
  };
  return source;
}

/** Every batch `source` answers, pulled with `limit` until it says done. */
async function drain(source: ResultSource, limit: BatchLimit): Promise<RowBatch[]> {
  const batches: RowBatch[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a source is pulled one batch at a time, the pull being the credit.
    const batch = await source.next(limit);
    batches.push(batch);
    if (batch.done) return batches;
  }
}

const SMALL = { maxRows: 100, maxBytes: 1000, batchMaxBytes: 100 };

describe("the byte budgets and the row measure", () => {
  test("the batch and page budgets are one MiB and 32 MiB", () => {
    expect(BATCH_MAX_BYTES).toBe(1048576);
    expect(PAGE_MAX_BYTES).toBe(33554432);
    expect(PAGE_ENDS).toEqual(["done", "row-limit", "byte-limit"]);
  });

  test("a row's size is the UTF-8 length of its encoded JSON text", () => {
    const text = (): string => randomUUID();
    const rows: unknown[][] = [
      [],
      [text(), `${text()}éß`, `${text()}€中`, `${text()}\u{1f600}\u{10348}`, '"\\\n\u0001'],
      [BigInt(2) ** BigInt(63), -(BigInt(2) ** BigInt(63)), 0, -0, 1.5, Number.NaN, Infinity, -Infinity],
      [new Uint8Array([0, 255, 7]), new Date(86_400_000), null, true, false],
      [{ a: { b: [text(), { $: text(), v: 1 }] } }, [[text()]]],
    ];
    const encoder = new TextEncoder();

    for (const row of rows) {
      expect(encodedRowBytes(row)).toBe(encoder.encode(JSON.stringify(encodeValue(row))).byteLength);
    }
    expect(encodedRowBytes([])).toBe(2);
    expect(encodedRowBytes(["\u{1f600}"])).toBe(8);
    expect(() => encodedRowBytes([new Map()])).toThrow(ValueCodecError);
  });
});

describe("rowsSource", () => {
  test("a batch held to batch.maxBytes", async () => {
    const rows = Array.from({ length: 3000 }, (_, index) => [index, `${randomUUID()}${"r".repeat(1000)}`]);
    const source = rowsSource(TWO, rows, 3000);

    expect(source.columns).toBe(TWO);
    expect(source.rowCount).toBe(3000);
    expect(rowsSource(TWO, rows).rowCount).toBeUndefined();
    const batches = await drain(source, { maxRows: 5000, maxBytes: BATCH_MAX_BYTES });
    expect(batches.length).toBeGreaterThan(2);
    for (const batch of batches) {
      const bytes = batch.rows.reduce((sum, row) => sum + encodedRowBytes(row), 0);
      expect(bytes).toBeLessThanOrEqual(BATCH_MAX_BYTES);
      expect(batch.rows.length).toBeLessThanOrEqual(5000);
    }
    expect(batches.flatMap((batch) => batch.rows)).toEqual(rows);
    expect(batches.map((batch) => batch.done)).toEqual([...batches.slice(1).map(() => false), true]);

    const byRows = await drain(rowsSource(TWO, rows), { maxRows: 7, maxBytes: BATCH_MAX_BYTES });
    expect(byRows.every((batch) => batch.rows.length <= 7)).toBe(true);
    expect(byRows.flatMap((batch) => batch.rows)).toEqual(rows);
    expect(await rowsSource(TWO, []).next({ maxRows: 1, maxBytes: 1 })).toEqual({ rows: [], done: true });

    await source.close();
    const error = await thrownBy(() => source.next({ maxRows: 1, maxBytes: 1 }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The result source was closed, so it answers no more batches.");
  });
});

describe("pumpPage", () => {
  test("a page cut by size at page.maxBytes", async () => {
    const row = rowOf(64 * 1024);
    const exact = await pumpPage(
      rowsSource(
        ONE,
        Array.from({ length: 600 }, () => row),
      ),
      { maxRows: 100_000, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES },
    );
    expect(exact.end).toBe("byte-limit");
    expect(exact.bytes).toBe(PAGE_MAX_BYTES);
    expect(exact.rows.length).toBe(512);

    const uneven = rowOf(64 * 1024 + 5);
    const cut = await pumpPage(
      rowsSource(
        ONE,
        Array.from({ length: 600 }, () => uneven),
      ),
      { maxRows: 100_000, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES },
    );
    expect(cut.end).toBe("byte-limit");
    expect(cut.rows.length).toBe(Math.floor(PAGE_MAX_BYTES / (64 * 1024 + 5)));
    expect(cut.bytes).toBe(cut.rows.length * (64 * 1024 + 5));
    expect(cut.bytes).toBeLessThanOrEqual(PAGE_MAX_BYTES);
  });

  test("a page ends at its row limit or when the source is done", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => [index]);
    const all = await pumpPage(rowsSource(ONE, rows), SMALL);
    const limited = await pumpPage(rowsSource(ONE, rows), { ...SMALL, maxRows: 12 });
    const exactly = await pumpPage(rowsSource(ONE, rows), { ...SMALL, maxRows: 30 });
    const empty = await pumpPage(rowsSource(ONE, []), SMALL);

    expect(all).toEqual({ rows, bytes: rows.reduce((sum, row) => sum + encodedRowBytes(row), 0), end: "done" });
    expect(Object.isFrozen(all)).toBe(true);
    expect(limited.rows).toEqual(rows.slice(0, 12));
    expect(limited.end).toBe("row-limit");
    expect(exactly.rows).toEqual(rows);
    expect(exactly.end).toBe("done");
    expect(empty).toEqual({ rows: [], bytes: 0, end: "done" });
  });

  test("a row larger than the batch budget comes alone, and is refused only when no page can hold it", async () => {
    const big = rowOf(300);
    const alone = await rowsSource(ONE, [big, [1]]).next({ maxRows: 10, maxBytes: 100 });
    expect(alone).toEqual({ rows: [big], done: false });

    const kept = await pumpPage(rowsSource(ONE, [[1], big, [2]]), SMALL);
    expect(kept.rows).toEqual([[1], big, [2]]);
    expect(kept.end).toBe("done");

    const filler = Array.from({ length: 4 }, () => rowOf(80));
    const endedBefore = await pumpPage(rowsSource(ONE, [...filler, rowOf(900), [2]]), { ...SMALL, maxBytes: 1000 });
    expect(endedBefore).toEqual({ rows: filler, bytes: 320, end: "byte-limit" });

    const source = scripted(ONE, () => ({ rows: [rowOf(1001)], done: true }));
    const error = await thrownBy(() => pumpPage(source, SMALL));
    expect(error).toBeInstanceOf(CallRefusalError);
    expect((error as CallRefusalError).refusals).toEqual([
      { rule: "row-over-page", pointer: "/rows/0", limit: 1000, size: 1001 },
    ]);
    expect(source.closes).toBe(1);
  });

  test("a batch a source should not have answered is refused by name, and the source is closed once", async () => {
    const accessor = Object.defineProperty({ done: true }, "rows", { enumerable: true, get: () => [] });
    const cases: [readonly Column[], (pull: number, limit: BatchLimit) => unknown, CallRefusal[]][] = [
      [
        ONE,
        (_, limit) => ({ rows: Array.from({ length: limit.maxRows + 1 }, () => [1]), done: false }),
        [{ rule: "batch-over-rows", pointer: "/rows", limit: 100, size: 101 }],
      ],
      [
        ONE,
        () => ({ rows: [rowOf(60), rowOf(60)], done: false }),
        [{ rule: "batch-over-bytes", pointer: "/rows", limit: 100, size: 120 }],
      ],
      [
        TWO,
        () => ({ rows: [[1, 2], [1], "row", [1, 2, 3]], done: true }),
        [
          { rule: "row-not-positional", pointer: "/rows/1" },
          { rule: "row-not-positional", pointer: "/rows/2" },
          { rule: "row-not-positional", pointer: "/rows/3" },
        ],
      ],
      [ONE, () => null, [{ rule: "batch-malformed", pointer: "" }]],
      [ONE, () => [[1]], [{ rule: "batch-malformed", pointer: "" }]],
      [ONE, () => ({ rows: [], done: true, more: 1 }), [{ rule: "batch-malformed", pointer: "/more" }]],
      [ONE, () => ({ done: true }), [{ rule: "batch-malformed", pointer: "/rows" }]],
      [
        ONE,
        () => ({ rows: {}, done: "yes" }),
        [
          { rule: "batch-malformed", pointer: "/rows" },
          { rule: "batch-malformed", pointer: "/done" },
        ],
      ],
      [ONE, () => accessor, [{ rule: "batch-malformed", pointer: "/rows" }]],
      [ONE, () => ({ rows: [], done: false }), [{ rule: "batch-empty-not-done", pointer: "" }]],
    ];

    const results = await Promise.all(
      cases.map(async ([columns, answer, expected]) => {
        const source = scripted(columns, answer);
        return { error: await thrownBy(() => pumpPage(source, SMALL)), source, expected };
      }),
    );
    for (const { error, source, expected } of results) {
      expect(error).toBeInstanceOf(CallRefusalError);
      expect((error as CallRefusalError).refusals).toEqual(expected);
      expect(source.closes).toBe(1);
      expect(source.limits.length).toBe(1);
    }
    const cell = scripted(ONE, () => ({ rows: [[new Map()]], done: true }));
    expect(await thrownBy(() => pumpPage(cell, SMALL))).toBeInstanceOf(ValueCodecError);
    expect(cell.closes).toBe(1);
  });

  test("a failure to pull or to close is thrown, and neither is lost", async () => {
    const pullFailure = new Error(`pull ${randomUUID()}`);
    const closeFailure = new Error(`close ${randomUUID()}`);
    const failingClose = async (): Promise<void> => {
      throw closeFailure;
    };

    const pull = scripted(ONE, () => Promise.reject(pullFailure));
    expect(await thrownBy(() => pumpPage(pull, SMALL))).toBe(pullFailure);
    expect(pull.closes).toBe(1);

    const both = scripted(ONE, () => Promise.reject(pullFailure), failingClose);
    const aggregate = await thrownBy(() => pumpPage(both, SMALL));
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([pullFailure, closeFailure]);
    expect((aggregate as AggregateError).cause).toBe(closeFailure);
    expect(both.closes).toBe(1);

    const refusedAndClose = scripted(ONE, () => ({ rows: [], done: false }), failingClose);
    const refusedAggregate = await thrownBy(() => pumpPage(refusedAndClose, SMALL));
    expect(refusedAggregate).toBeInstanceOf(AggregateError);
    const [refusal, closed] = (refusedAggregate as AggregateError).errors;
    expect(refusal).toBeInstanceOf(CallRefusalError);
    expect(closed).toBe(closeFailure);

    const afterGoodPage = scripted(ONE, () => ({ rows: [[1]], done: true }), failingClose);
    expect(await thrownBy(() => pumpPage(afterGoodPage, SMALL))).toBe(closeFailure);
    expect(afterGoodPage.closes).toBe(1);
  });

  test("the limits a source is asked for are frozen and within the page", async () => {
    const inner = rowsSource(
      ONE,
      Array.from({ length: 50 }, (_, index) => rowOf(index % 2 === 0 ? 70 : 10)),
    );
    const asked: BatchLimit[] = [];
    const answered: RowBatch[] = [];
    const source: ResultSource = {
      columns: ONE,
      async next(limit) {
        asked.push(limit);
        const batch = await inner.next(limit);
        answered.push(batch);
        return batch;
      },
      close: () => inner.close(),
    };

    const page = await pumpPage(source, { maxRows: 20, maxBytes: 400, batchMaxBytes: 100 });

    let rowsSoFar = 0;
    let bytesSoFar = 0;
    expect(asked.length).toBe(5);
    for (const [pull, limit] of asked.entries()) {
      expect(Object.isFrozen(limit)).toBe(true);
      expect(limit).toEqual({ maxRows: 20 - rowsSoFar, maxBytes: Math.min(100, 400 - bytesSoFar) });
      rowsSoFar += answered[pull].rows.length;
      bytesSoFar += answered[pull].rows.reduce((sum, row) => sum + encodedRowBytes(row), 0);
    }
    expect(page.end).toBe("byte-limit");
    expect(page.bytes).toBe(400);
    expect(page.rows.length).toBe(10);
  });

  test("a pump limit that is not a positive safe integer is refused before any pull", async () => {
    const bad = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, undefined];
    const names = ["maxRows", "maxBytes", "batchMaxBytes"] as const;

    const results = await Promise.all(
      names.flatMap((name) =>
        bad.map(async (value) => {
          const source = scripted(ONE, () => ({ rows: [], done: true }));
          const error = await thrownBy(() => pumpPage(source, { ...SMALL, [name]: value } as typeof SMALL));
          return { name, error, source };
        }),
      ),
    );
    for (const { name, error, source } of results) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as RangeError).message).toBe(`The pump limit ${name} must be a positive safe integer.`);
      expect(source.limits.length).toBe(0);
      expect(source.closes).toBe(1);
    }
  });

  test("every call refusal of a batch is worded with its counts", () => {
    expect(callRefusalSentence({ rule: "batch-over-bytes", pointer: "/rows", limit: 100, size: 120 })).toBe(
      'The batch a result source answered holds 120 bytes of rows at "/rows", in more than one row, over its limit of 100 bytes.',
    );
    expect(callRefusalSentence({ rule: "row-over-page", pointer: "/rows/0", limit: 1000, size: 1001 })).toBe(
      'The row at "/rows/0" of a batch is 1001 bytes, over a whole page\'s limit of 1000 bytes, so no page can hold it.',
    );
  });
});
