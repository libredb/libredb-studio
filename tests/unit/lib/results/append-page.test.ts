import { describe, expect, test } from "bun:test";
import { appendResultPage, type ShownResult } from "@/lib/results/append-page";
import type { QueryResult } from "@/lib/types";

const vectors = { emb: { kind: "dense", dtype: "float32", dimension: 3 } } as const;
const shownOf = (more: Partial<ShownResult> = {}): ShownResult => ({
  rows: [{ n: 1 }, { n: 2 }],
  fields: ["n"],
  ...more,
});
const pageOf = (more: Partial<QueryResult> = {}): QueryResult => ({
  rows: [{ n: 3 }],
  fields: ["n"],
  rowCount: 1,
  executionTime: 7,
  pagination: { limit: 2, offset: 2, hasMore: false, totalReturned: 1, wasLimited: false },
  ...more,
});

describe("appendResultPage", () => {
  test("rows are concatenated after the rows on screen and rowCount is the merged count", () => {
    expect(appendResultPage(shownOf(), pageOf())).toEqual({
      rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
      fields: ["n"],
      rowCount: 3,
      executionTime: 7,
      pagination: { limit: 2, offset: 2, hasMore: false, totalReturned: 1, wasLimited: false },
    });
  });
  test("an empty page that names no fields keeps the fields the rows are rendered under", () => {
    const merged = appendResultPage(shownOf(), pageOf({ rows: [], fields: [], rowCount: 0 }));
    expect(merged.fields).toEqual(["n"]);
    expect(merged.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(merged.rowCount).toBe(2);
  });
  test("a page that names fields is believed", () => {
    expect(appendResultPage(shownOf(), pageOf({ fields: ["n", "m"] })).fields).toEqual(["n", "m"]);
  });
  test("a page that declares no vectorColumns keeps the rows' declaration", () => {
    expect(appendResultPage(shownOf({ vectorColumns: vectors }), pageOf()).vectorColumns).toEqual(vectors);
  });
  test("a page that declares its own vectorColumns is believed", () => {
    const own = { v: { kind: "dense", dtype: "float32", dimension: 2 } } as const;
    expect(appendResultPage(shownOf({ vectorColumns: vectors }), pageOf({ vectorColumns: own })).vectorColumns).toEqual(
      own,
    );
  });
  test("with no declaration on either side the key is absent, not undefined", () => {
    expect(Object.hasOwn(appendResultPage(shownOf(), pageOf()), "vectorColumns")).toBe(false);
  });
  test("every other key comes from the newest page, and nothing else is carried", () => {
    const shown = {
      ...shownOf(),
      rowCount: 2,
      executionTime: 3,
      warnings: [{ message: "old" }],
      columnTypes: { n: "int4" },
    };
    const page = { ...pageOf({ executionTime: 9 }), inTransaction: true } as QueryResult;
    const merged = appendResultPage(shown, page);
    expect(merged.executionTime).toBe(9);
    expect(merged.pagination).toEqual({ limit: 2, offset: 2, hasMore: false, totalReturned: 1, wasLimited: false });
    expect(Object.hasOwn(merged, "warnings")).toBe(false);
    expect(Object.hasOwn(merged, "columnTypes")).toBe(false);
    expect((merged as QueryResult & { inTransaction?: boolean }).inTransaction).toBe(true);
  });
  test("neither input is changed", () => {
    const shown = shownOf();
    const page = pageOf();
    const merged = appendResultPage(shown, page);
    expect(shown.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(page.rows).toEqual([{ n: 3 }]);
    expect(merged.rows).not.toBe(shown.rows);
  });
});
