/**
 * How the legacy bridge (src/lib/provider-host/legacy-bridge.ts) measures a row the value codec refuses: in the row's
 * JSON form, found before the codec is asked, so no `ValueCodecError` is thrown per row. A MongoDB result read
 * positionally under its union of fields has an undefined cell in every document that lacks a field, so a throw per
 * row was one per document.
 *
 * The SDK's `encodedRowBytes` is replaced, for the bridge's import only, by one that counts the codec's refusals it
 * throws; it is a module mock, so this file runs in its own process (tests/run-tests.ts).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as calls from "@libredb/provider-sdk/calls";
import { ValueCodecError } from "@libredb/provider-sdk/values";
import { createMockProvider } from "../../../helpers/mock-provider";

const real = { ...calls };
let refusalsThrown = 0;
mock.module("@libredb/provider-sdk/calls", () => ({
  ...real,
  encodedRowBytes: (row: readonly unknown[]): number => {
    try {
      return real.encodedRowBytes(row);
    } catch (error) {
      if (error instanceof ValueCodecError) refusalsThrown += 1;
      throw error;
    }
  },
}));

const { bridgedConsole } = await import("@/lib/provider-host/legacy-bridge");

const PAGE = { maxRows: 1_000, maxBytes: calls.PAGE_MAX_BYTES, batchMaxBytes: calls.BATCH_MAX_BYTES } as const;
const HOUR = 3_600_000;

/** The page the bridge answers for `rows` under `fields`; `refusalsThrown` counts what the codec threw meanwhile. */
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
  return await calls.pumpPage(answer.results[0] as calls.ResultSource, PAGE, ctx);
}

describe("the bridge's measure of a row the value codec refuses", () => {
  beforeEach(() => {
    refusalsThrown = 0;
  });

  class Point {
    constructor(readonly at: number) {}
  }

  test("a row with an undefined cell is measured in its JSON form, and the codec throws nothing", async () => {
    const rows = Array.from({ length: 50 }, (_, n) => ({ _id: `id-${n}`, qty: n }));

    const page = await measured(["_id", "qty", "missing"], rows);

    expect(refusalsThrown).toBe(0);
    expect(page.rows).toEqual(rows.map((row) => [row._id, row.qty, null]));
    expect(page.bytes).toBe(rows.reduce((sum, row) => sum + real.encodedRowBytes([row._id, row.qty, null]), 0));
  });

  test("a row with a Map is measured in its JSON form, and the codec throws nothing", async () => {
    const page = await measured(["m"], [{ m: new Map([["k", 1]]) }]);

    expect(refusalsThrown).toBe(0);
    expect(page.rows).toEqual([[{}]]);
    expect(page.bytes).toBe(real.encodedRowBytes([{}]));
  });

  test("a row with a class instance, nested in a cell, is measured in its JSON form, and the codec throws nothing", async () => {
    const page = await measured(["p"], [{ p: { at: [new Point(3)] } }]);

    expect(refusalsThrown).toBe(0);
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

    expect(refusalsThrown).toBe(0);
    pages.forEach((page, index) => {
      expect(page.rows).toEqual([codecForm([values[index]])]);
    });
  });

  test("a bigint outside the codec's range fails the measure as JSON fails it", async () => {
    const caught = await measured(["v"], [{ v: BigInt(2) ** BigInt(64) }]).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TypeError);
  });
});
