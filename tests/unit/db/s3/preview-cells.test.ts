/**
 * Cells and rows of the S3 preview: every row of the cell table, the iterative
 * serializer that never calls JSON.stringify on a stored or decoded value and never recurses, the column
 * bound applied before any cell is rendered, and the row, output and cell caps with their notices.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import {
  buildRows,
  cutText,
  jsonString,
  renderCell,
  scalarJson,
  selectColumns,
  serializeBounded,
} from "@/lib/db/providers/objectstore/s3/preview-cells";

const limits = (changes: Partial<typeof S3_PREVIEW_LIMITS>) => ({ ...S3_PREVIEW_LIMITS, ...changes });

describe("renderCell: the cell table", () => {
  test("null and undefined give null; booleans and finite numbers stay themselves", () => {
    expect(renderCell(null, 10)).toEqual({ cell: null, cut: false });
    expect(renderCell(undefined, 10)).toEqual({ cell: null, cut: false });
    expect(renderCell(true, 10)).toEqual({ cell: true, cut: false });
    expect(renderCell(1.5, 10)).toEqual({ cell: 1.5, cut: false });
  });

  test("NaN and the infinities are strings", () => {
    expect(renderCell(Number.NaN, 10).cell).toBe("NaN");
    expect(renderCell(Number.POSITIVE_INFINITY, 10).cell).toBe("Infinity");
    expect(renderCell(Number.NEGATIVE_INFINITY, 10).cell).toBe("-Infinity");
  });

  test("a bigint within 2^53 is a number, beyond it its digits", () => {
    expect(renderCell(BigInt("9007199254740991"), 100).cell).toBe(9_007_199_254_740_991);
    expect(renderCell(BigInt("-9007199254740991"), 100).cell).toBe(-9_007_199_254_740_991);
    expect(renderCell(BigInt("9007199254740993"), 100).cell).toBe("9007199254740993");
  });

  test("a string is cut at cellChars UTF-16 units, never between the halves of a surrogate pair", () => {
    expect(renderCell("abcdef", 4)).toEqual({ cell: "abcd", cut: true });
    expect(renderCell("ab\u{1F600}", 3)).toEqual({ cell: "ab", cut: true });
    expect(renderCell("abc", 3)).toEqual({ cell: "abc", cut: false });
  });

  test("bytes are hex pairs beside a suffix that is never cut", () => {
    expect(renderCell(Uint8Array.of(0x00, 0x01), 100)).toEqual({ cell: "0001 (2 bytes)", cut: false });
    expect(renderCell(new Uint8Array(1_000), 20)).toEqual({ cell: "000000 (1,000 bytes)", cut: true });
    expect(renderCell(new Uint8Array(1_000), 5)).toEqual({ cell: " (1,000 bytes)", cut: true });
  });

  test("a Date is its ISO text without the Z, and an invalid Date its time value", () => {
    expect(renderCell(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), 100).cell).toBe("2026-01-02T03:04:05.006");
    expect(renderCell(new Date(Number.NaN), 100).cell).toBe("NaN");
  });

  test("any other value is its String form, cut", () => {
    expect(renderCell(Symbol("x"), 100).cell).toBe("Symbol(x)");
  });
});

describe("serializeBounded", () => {
  test("bigints as digit strings, bytes as hex, a Date without Z, a __proto__ key written as a key", () => {
    const value = JSON.parse('{"__proto__":1,"b":[true,null]}') as Record<string, unknown>;
    value.big = BigInt(12);
    value.bytes = Uint8Array.of(0xab);
    value.when = new Date(Date.UTC(2026, 0, 1));
    value.nan = Number.NaN;
    value.text = 'q"\\\n\u0001\ud800 \udc00 \u{1F600}\t';
    expect(serializeBounded(value, 1_000, 64)).toEqual({
      text: '{"__proto__":1,"b":[true,null],"big":"12","bytes":"ab","when":"2026-01-01T00:00:00.000","nan":"NaN","text":"q\\"\\\\\\n\\u0001\\ud800 \\udc00 \u{1F600}\\t"}',
      cut: false,
    });
  });

  test("a value nested 100,000 deep renders as a cut cell with no throw", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 100_000; level += 1) deep = [deep];
    const rendered = renderCell(deep, 65_536, 64);
    expect(rendered.cut).toBe(true);
    expect(rendered.cell).toBe(`${"[".repeat(64)}...${"]".repeat(64)}`);
  });

  test("one level past cellMaxDepth is written as ... and counted", () => {
    expect(serializeBounded([[[1]]], 1_000, 2)).toEqual({ text: "[[...]]", cut: true });
    expect(serializeBounded([[1]], 1_000, 2)).toEqual({ text: "[[1]]", cut: false });
  });

  test("it stops as soon as it has written past cellChars", () => {
    const rendered = serializeBounded(
      Array.from({ length: 1_000_000 }, (_, index) => index),
      10,
      64,
    );
    expect(rendered).toEqual({ text: "[0,1,2,3,4", cut: true });
  });

  test("a string far past cellChars of characters that escape to six gives the same cut cell", () => {
    const long = "\u0001".repeat(4_000_000);
    expect(serializeBounded({ k: long }, 20, 64)).toEqual({ text: '{"k":"\\u0001\\u0001\\u', cut: true });
    expect(serializeBounded({ [long]: 1 }, 20, 64)).toEqual({ text: '{"\\u0001\\u0001\\u0001', cut: true });
    expect(serializeBounded([Uint8Array.of(0xab, 0xcd, 0xef)], 4, 64)).toEqual({ text: '["ab', cut: true });
  });

  test("the bounded escape writes at most the budget plus one escaped input character, and past the budget", () => {
    const long = "\u0001".repeat(4_000_000);
    const escaped = jsonString(long, 100);
    expect(escaped.length).toBeGreaterThan(100);
    expect(escaped.length).toBeLessThanOrEqual(1 + 6 * 101);
    expect(escaped).toBe(`"${"\\u0001".repeat(101)}`);
    expect(jsonString("a\u{1F600}b", 1)).toBe('"a\u{1F600}');
    expect(jsonString("ab", -5)).toBe('"');
    expect(jsonString("ab", 3)).toBe('"ab"');
  });

  test("bytes are hex-written only as far as the budget needs", () => {
    const hex = scalarJson(new Uint8Array(8_000_000), 10);
    expect(hex).toBe(`"${"00".repeat(6)}`);
    expect(scalarJson(Uint8Array.of(0xab), 10)).toBe('"ab"');
  });

  test("renderCell never calls JSON.stringify", () => {
    const spy = spyOn(JSON, "stringify");
    try {
      renderCell({ a: [1, { b: "c" }], d: BigInt(2) }, 1_000);
      renderCell("text", 1_000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("cutText", () => {
  test("keeps a whole pair and drops a high surrogate left alone by the cut", () => {
    expect(cutText("a\u{1F600}", 3)).toEqual({ text: "a\u{1F600}", cut: false });
    expect(cutText("a\u{1F600}b", 2)).toEqual({ text: "a", cut: true });
  });
});

describe("selectColumns", () => {
  test("an explicit list keeps exactly those columns in that order, renamed names included", () => {
    expect(selectColumns(["a", "b", "value (2)"], ["value (2)", "a"], 1_024)).toEqual({ indexes: [2, 0], notices: [] });
  });

  test("an unknown name is refused with R-COLUMN naming the first unknown one", () => {
    expect(() => selectColumns(["a"], ["a", "first name", "zz"], 1_024)).toThrow(
      new QueryError("The preview has no column 'first name'.", "s3"),
    );
  });

  test("without a list, columns past maxColumns are dropped with N-COLUMNS", () => {
    expect(selectColumns(["a", "b", "c"], undefined, 2)).toEqual({
      indexes: [0, 1],
      notices: ["Showing the first 2 of 3 columns."],
    });
  });

  test("a source holding more columns than it names reports its true count in N-COLUMNS", () => {
    expect(selectColumns(["a", "b", "c"], undefined, 2, 9_000)).toEqual({
      indexes: [0, 1],
      notices: ["Showing the first 2 of 9,000 columns."],
    });
    expect(selectColumns(["a", "b"], undefined, 2, 9_000)).toEqual({
      indexes: [0, 1],
      notices: ["Showing the first 2 of 9,000 columns."],
    });
    expect(
      buildRows(
        { names: ["a"], typing: "text", rowCount: 0, valueAt: () => null, columnCount: 3 },
        undefined,
        10,
        limits({ maxColumns: 1 }),
      ).notices,
    ).toEqual(["Showing the first 1 of 3 columns."]);
  });
});

describe("buildRows", () => {
  const grid = (rows: unknown[][]) => ({
    names: ["a", "b"],
    typing: "text" as const,
    rowCount: rows.length,
    valueAt: (row: number, column: number) => rows[row][column],
  });

  test("a type list of another length than the names is a defect and throws", () => {
    expect(() =>
      buildRows(
        { names: ["a", "b"], typing: ["text"], rowCount: 0, valueAt: () => null },
        undefined,
        2,
        S3_PREVIEW_LIMITS,
      ),
    ).toThrow("A row source gives 1 column type(s) for 2 column name(s)");
  });

  test("rows stop at maxRows with N-ROWS only when more were available", () => {
    const built = buildRows(
      grid([
        ["1", "2"],
        ["3", "4"],
        ["5", "6"],
      ]),
      undefined,
      2,
      S3_PREVIEW_LIMITS,
    );
    expect(built.rows).toEqual({
      columns: [
        { name: "a", type: "text" },
        { name: "b", type: "text" },
      ],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
    expect(built.notices).toEqual(["The preview stops at 2 rows."]);
    expect(buildRows(grid([["1", "2"]]), undefined, 2, S3_PREVIEW_LIMITS).notices).toEqual([]);
  });

  test("the output cap stops before the row whose cells would cross it", () => {
    const built = buildRows(
      grid([
        ["abc", "de"],
        ["fgh", "ij"],
        ["k", "l"],
      ]),
      undefined,
      10,
      limits({ outputChars: 7 }),
    );
    expect(built.rows.rows).toEqual([["abc", "de"]]);
    expect(built.notices).toEqual(["The preview stopped after 1 row, at 7 characters of cell text."]);
    const two = buildRows(
      grid([
        ["abc", "de"],
        ["fg", "h"],
        ["k", "l"],
      ]),
      undefined,
      10,
      limits({ outputChars: 9 }),
    );
    expect(two.notices).toEqual(["The preview stopped after 2 rows, at 9 characters of cell text."]);
  });

  test("cut cells are counted with the cap in force", () => {
    const built = buildRows(
      grid([
        ["abcdef", "x"],
        ["ghijkl", "y"],
      ]),
      undefined,
      10,
      limits({ cellChars: 3 }),
    );
    expect(built.rows.rows).toEqual([
      ["abc", "x"],
      ["ghi", "y"],
    ]);
    expect(built.notices).toEqual(["2 cell(s) were cut at 3 characters."]);
  });

  test("the column bound applies before cells are rendered: a source of 100,000 columns renders maxColumns cells a row", () => {
    let reads = 0;
    const names = Array.from({ length: 100_000 }, (_, index) => `c${index}`);
    const built = buildRows(
      {
        names,
        typing: "text",
        rowCount: 1,
        valueAt: () => {
          reads += 1;
          return "v";
        },
      },
      undefined,
      10,
      limits({ maxColumns: 3 }),
    );
    expect(built.rows.columns.map((column) => column.name)).toEqual(["c0", "c1", "c2"]);
    expect(reads).toBe(3);
    expect(built.notices).toEqual(["Showing the first 3 of 100,000 columns."]);
  });

  test("JSON typing: the kind every non-null cell shares, else json", () => {
    const rows: unknown[][] = [
      ["a", 1, true, [1], { k: 1 }, null, "x"],
      ["b", BigInt(2), false, [], {}, null, 3],
    ];
    const built = buildRows(
      {
        names: ["s", "n", "b", "arr", "obj", "nil", "mixed"],
        typing: "json",
        rowCount: rows.length,
        valueAt: (row, column) => rows[row][column],
      },
      undefined,
      10,
      S3_PREVIEW_LIMITS,
    );
    expect(built.rows.columns.map((column) => column.type)).toEqual([
      "string",
      "number",
      "boolean",
      "array",
      "object",
      "json",
      "json",
    ]);
  });

  test("fixed typing names each column's type, and available rows beyond the shown ones give N-ROWS", () => {
    const built = buildRows(
      { names: ["id"], typing: ["INT64"], rowCount: 1, valueAt: () => BigInt(7), available: 5 },
      undefined,
      1,
      S3_PREVIEW_LIMITS,
    );
    expect(built.rows).toEqual({ columns: [{ name: "id", type: "INT64" }], rows: [[7]] });
    expect(built.notices).toEqual(["The preview stops at 1 rows."]);
  });
});
