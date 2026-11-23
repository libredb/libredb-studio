/**
 * How the legacy bridge (src/lib/provider-host/legacy-bridge.ts) measures a row the value codec refuses: in the row's
 * JSON form, found before the codec is asked, so no `ValueCodecError` is thrown per row. A MongoDB result read
 * positionally under its union of fields has an undefined cell in every document that lacks a field, so a throw per
 * row was one per document.
 *
 * The bridge sizes each row with the measure of the pull that asks for it, so the count is taken there: a source
 * wrapper hands the bridge the pump's own measure wrapped in a counter of its calls and of the `ValueCodecError`s it
 * throws, calling it with the same array, so the pump's records still hold the row.
 */
import { describe, expect, mock, test } from "bun:test";
import * as calls from "@libredb/provider-sdk/calls";
import { ValueCodecError } from "@libredb/provider-sdk/values";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import { createMockProvider } from "../../../helpers/mock-provider";

const real = { ...calls };

const PAGE = { maxRows: 1_000, maxBytes: calls.PAGE_MAX_BYTES, batchMaxBytes: calls.BATCH_MAX_BYTES } as const;
const HOUR = 3_600_000;

/** What `source` answers, each pull's measure wrapped to count its calls and the codec's refusals it throws. */
function counting(source: calls.ResultSource): {
  readonly source: calls.ResultSource;
  readonly counts: { measured: number; refusalsThrown: number };
} {
  const counts = { measured: 0, refusalsThrown: 0 };
  return {
    counts,
    source: {
      columns: source.columns,
      next: (limit) =>
        source.next({
          maxRows: limit.maxRows,
          maxBytes: limit.maxBytes,
          measure: (row) => {
            counts.measured += 1;
            try {
              return limit.measure(row);
            } catch (error) {
              if (error instanceof ValueCodecError) counts.refusalsThrown += 1;
              throw error;
            }
          },
        }),
      close: () => source.close(),
    },
  };
}

/**
 * The page the bridge answers for `rows` under `fields`, once every row was sized with its pull's measure, and how
 * many refusals the codec threw meanwhile.
 */
async function measured(fields: string[], rows: Record<string, unknown>[]) {
  const provider = Object.assign(createMockProvider(), {
    prepareQuery: mock((query: string) => ({ query, wasLimited: false, limit: 500, offset: 0 })),
    query: mock(async () => ({ rows, fields, rowCount: rows.length, executionTime: 1 })),
  });
  const ctx = {
    deadline: Date.now() + HOUR,
    signal: new AbortController().signal,
    env: calls.envReader([], () => undefined),
  };
  const answer = await bridgedConsole(provider, {}).session.execute(
    calls.freezeData({ statement: "find", page: { limit: 500, offset: 0 } }),
    ctx,
  );
  const { source, counts } = counting(answer.results[0] as calls.ResultSource);
  const page = await calls.pumpPage(source, PAGE, ctx);
  expect(counts.measured).toBe(rows.length);
  return { ...page, refusalsThrown: counts.refusalsThrown };
}

describe("the bridge's measure of a row the value codec refuses", () => {
  class Point {
    constructor(readonly at: number) {}
  }

  test("a row with an undefined cell is measured in its JSON form, and the codec throws nothing", async () => {
    const rows = Array.from({ length: 50 }, (_, n) => ({ _id: `id-${n}`, qty: n }));

    const page = await measured(["_id", "qty", "missing"], rows);

    expect(page.refusalsThrown).toBe(0);
    expect(page.rows).toEqual(rows.map((row) => [row._id, row.qty, null]));
    expect(page.bytes).toBe(rows.reduce((sum, row) => sum + real.encodedRowBytes([row._id, row.qty, null]), 0));
  });

  test("a row with a Map is measured in its JSON form, and the codec throws nothing", async () => {
    const page = await measured(["m"], [{ m: new Map([["k", 1]]) }]);

    expect(page.refusalsThrown).toBe(0);
    expect(page.rows).toEqual([[{}]]);
    expect(page.bytes).toBe(real.encodedRowBytes([{}]));
  });

  test("a row with a class instance, nested in a cell, is measured in its JSON form, and the codec throws nothing", async () => {
    const page = await measured(["p"], [{ p: { at: [new Point(3)] } }]);

    expect(page.refusalsThrown).toBe(0);
    expect(page.rows).toEqual([[{ at: [{ at: 3 }] }]]);
    expect(page.bytes).toBe(real.encodedRowBytes([{ at: [{ at: 3 }] }]));
  });

  test("the bridge reads the codec's domain as the codec does, for every kind it takes and refuses", async () => {
    const hole: unknown[] = [];
    hole[1] = 1;
    const values: unknown[] = [
      "s",
      true,
      1.5,
      Number.NaN,
      BigInt(2) ** BigInt(63),
      null,
      [1, ["a"]],
      new Uint8Array([1, 2]),
      new Date(0),
      { a: { b: [1] } },
      Object.create(null),
      { $: "x", v: 1 },
      undefined,
      () => 1,
      Symbol("s"),
      hole,
      [1, undefined],
      new Date(Number.NaN),
      new Point(1),
      new Set([1]),
      { a: { b: undefined } },
    ];
    /** The measured form the bridge answered before it screened rows: the codec's, or the JSON form on its refusal. */
    const codecForm = (cells: unknown[]): unknown[] => {
      try {
        real.encodedRowBytes(cells);
        return cells;
      } catch (error) {
        if (!(error instanceof ValueCodecError)) throw error;
        return JSON.parse(JSON.stringify(cells)) as unknown[];
      }
    };

    const pages = await Promise.all(values.map((value) => measured(["v"], [{ v: value }])));

    pages.forEach((page, index) => {
      expect(page.refusalsThrown).toBe(0);
      expect(page.rows).toEqual([codecForm([values[index]])]);
    });
  });

  test("a bigint outside the codec's range fails the measure as JSON fails it", async () => {
    const caught = await measured(["v"], [{ v: BigInt(2) ** BigInt(64) }]).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TypeError);
  });
});
