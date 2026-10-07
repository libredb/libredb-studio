import { describe, test, expect } from "bun:test";
import { markdownCell, markdownTable } from "@/lib/export/markdown";

describe("markdownCell", () => {
  test("escapes a pipe so it cannot end the cell", () => {
    expect(markdownCell("a|b")).toBe("a\\|b");
  });

  test("doubles a backslash before escaping a pipe, so an already-escaped-looking value survives", () => {
    expect(markdownCell("a\\|b")).toBe("a\\\\\\|b");
    expect(markdownCell("\\")).toBe("\\\\");
  });

  test("turns a newline and a carriage return into a break, not a row split", () => {
    expect(markdownCell("line1\nline2")).toBe("line1<br>line2");
    expect(markdownCell("x\ry")).toBe("x<br>y");
    expect(markdownCell("a\r\nb")).toBe("a<br>b");
    expect(markdownCell("a\n\nb")).toBe("a<br><br>b");
  });

  test("writes an absent value as an empty cell, not as the text of the absence", () => {
    expect(markdownCell(null)).toBe("");
    expect(markdownCell(undefined)).toBe("");
  });

  test("writes a date in a form another tool can parse back", () => {
    expect(markdownCell(new Date("2026-08-17T06:31:49.000Z"))).toBe("2026-08-17T06:31:49.000Z");
  });

  test("writes a binary value as the shared hex, escaping its backslash prefix", () => {
    expect(markdownCell({ type: "Buffer", data: [0xde, 0xad] })).toBe("\\\\xdead");
    expect(markdownCell(new Uint8Array([0xde, 0xad]))).toBe("\\\\xdead");
    expect(markdownCell({ type: "Buffer", data: [] })).toBe("\\\\x");
  });

  test("keeps a document that only looks Buffer-shaped as JSON rather than misreading it as bytes", () => {
    expect(markdownCell({ type: "Buffer", data: [1, "two"] })).toBe('{"type":"Buffer","data":[1,"two"]}');
  });

  test("serializes a structured value and a bigint", () => {
    expect(markdownCell({ a: 1 })).toBe('{"a":1}');
    expect(markdownCell([1, 2])).toBe("[1,2]");
    expect(markdownCell(BigInt(10))).toBe("10");
  });

  test("writes booleans, numbers and non-ASCII text as themselves", () => {
    expect(markdownCell(true)).toBe("true");
    expect(markdownCell(-12.5)).toBe("-12.5");
    expect(markdownCell("雪🚀")).toBe("雪🚀");
  });
});

describe("markdownTable", () => {
  test("writes the header from the declared columns and reads each row by name", () => {
    const md = markdownTable([{ b: 2, a: 1 }], ["a", "b"]);
    expect(md).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  test("escapes a pipe in the header, not only in a cell", () => {
    expect(markdownTable([{ "a|b": 1 }], ["a|b"])).toBe("| a\\|b |\n| --- |\n| 1 |");
  });

  test("leaves a column a row does not carry empty rather than shifting the rest", () => {
    const md = markdownTable([{ a: 1, c: 3 }], ["a", "b", "c"]);
    expect(md).toBe("| a | b | c |\n| --- | --- | --- |\n| 1 |  | 3 |");
  });

  test("covers a key that only a later row carries when no columns are declared", () => {
    const md = markdownTable([{ a: 1 }, { a: 2, b: 3 }]);
    expect(md).toBe("| a | b |\n| --- | --- |\n| 1 |  |\n| 2 | 3 |");
  });

  test("writes a header with no rows under it when the columns are known but empty", () => {
    expect(markdownTable([], ["a", "b"])).toBe("| a | b |\n| --- | --- |");
  });

  test("writes nothing for no rows and no declared columns", () => {
    expect(markdownTable([])).toBe("");
  });

  test("writes an empty cell for a prototype-named column the row does not carry", () => {
    const md = markdownTable([{ constructor: "declared", id: 1 }, { id: 2 }], ["constructor", "id"]);
    expect(md).toBe("| constructor | id |\n| --- | --- |\n| declared | 1 |\n|  | 2 |");
  });

  test("still writes a row's own value for a prototype-named column", () => {
    expect(markdownTable([{ toString: "mine" }], ["toString"])).toBe("| toString |\n| --- |\n| mine |");
  });
});
