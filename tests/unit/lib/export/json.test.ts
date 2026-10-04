import { describe, test, expect } from "bun:test";
import { binaryCellsAsHex, jsonText } from "@/lib/export/json";

describe("jsonText", () => {
  test("writes an ordinary value the way JSON.stringify does", () => {
    expect(jsonText({ id: 1, name: "ada", ok: true, missing: null })).toBe(
      '{"id":1,"name":"ada","ok":true,"missing":null}',
    );
  });

  test("indents when asked, which is what the JSON export writes", () => {
    expect(jsonText([{ id: 1 }], 2)).toBe('[\n  {\n    "id": 1\n  }\n]');
  });

  test("writes a scalar handed in on its own", () => {
    expect(jsonText("plain")).toBe('"plain"');
    expect(jsonText(7)).toBe("7");
  });

  // A bigint has no JSON form, and `JSON.stringify` throws rather than dropping it.
  test("writes a bigint as its digits rather than throwing", () => {
    expect(jsonText({ big: BigInt("9007199254740993") })).toBe('{"big":"9007199254740993"}');
  });

  test("writes a bigint nested in an array", () => {
    expect(jsonText({ ids: [BigInt(1), BigInt(2)] })).toBe('{"ids":["1","2"]}');
  });

  test("writes a bigint handed in on its own", () => {
    expect(jsonText(BigInt(10))).toBe('"10"');
  });

  // `JSON.stringify` writes these three as `null`, which reads as SQL NULL in the file.
  test("writes NaN and the infinities as words rather than as null", () => {
    expect(jsonText({ f: Number.NaN, r: Number.POSITIVE_INFINITY, n: Number.NEGATIVE_INFINITY, ok: 1.5 })).toBe(
      '{"f":"NaN","r":"Infinity","n":"-Infinity","ok":1.5}',
    );
    expect(jsonText({ arr: [Number.NaN, 2] })).toBe('{"arr":["NaN",2]}');
    expect(jsonText(Number.NaN)).toBe('"NaN"');
  });

  // The value contains itself: there is no JSON form, so the cycle is named and
  // everything around it still lands in the file.
  test("names a cycle instead of throwing, and keeps the rest of the value", () => {
    const doc: Record<string, unknown> = { name: "root" };
    doc.self = doc;
    expect(jsonText(doc)).toBe('{"name":"root","self":"[Circular]"}');
  });

  test("names a cycle that closes further down", () => {
    const parent: Record<string, unknown> = { name: "parent" };
    parent.child = { name: "child", parent };
    expect(jsonText(parent)).toBe('{"name":"parent","child":{"name":"child","parent":"[Circular]"}}');
  });

  test("names a cycle through an array", () => {
    const items: unknown[] = [1];
    items.push(items);
    expect(jsonText({ items })).toBe('{"items":[1,"[Circular]"]}');
  });

  // The same object under two keys is ordinary in a result set — a shared lookup
  // row, a repeated sub-document. Only an ANCESTOR is a cycle.
  test("keeps both copies of a value referenced twice as siblings", () => {
    const shared = { code: "TR" };
    expect(jsonText({ from: shared, to: shared })).toBe('{"from":{"code":"TR"},"to":{"code":"TR"}}');
  });

  test("keeps both copies of a value repeated in an array", () => {
    const shared = { code: "TR" };
    expect(jsonText([shared, shared])).toBe('[{"code":"TR"},{"code":"TR"}]');
  });

  // `toJSON` is how a Date and every BSON value spell themselves; walking the value
  // without honouring it would turn a timestamp into `{}`.
  test("honours toJSON, so a date is its ISO string", () => {
    expect(jsonText({ at: new Date("2026-08-18T09:00:00.000Z") })).toBe('{"at":"2026-08-18T09:00:00.000Z"}');
  });

  test("walks what toJSON returns, so a bigint inside it is still written", () => {
    const bson = { toJSON: () => ({ $numberLong: BigInt(42) }) };
    expect(jsonText({ count: bson })).toBe('{"count":{"$numberLong":"42"}}');
  });
});

describe("binaryCellsAsHex", () => {
  // The grid, Copy Cell, the row detail and the CSV show a binary cell as `\x` hex; a
  // JSON file or a copied row wrote the Buffer form instead, one number per byte (#1381).
  test("writes a binary cell in the wire form as the hex the grid and the CSV show", () => {
    const row = { id: 1, payload: { type: "Buffer", data: [0xde, 0xad, 0xbe, 0xef, 0x00, 0xff] } };

    expect(binaryCellsAsHex(row)).toEqual({ id: 1, payload: "\\xdeadbeef00ff" });
  });

  test("writes a live Uint8Array the same way, which is how the embeddable shell hands one", () => {
    expect(binaryCellsAsHex({ payload: Uint8Array.from([0, 1, 255]) })).toEqual({ payload: "\\x0001ff" });
  });

  test("writes an empty binary value as the bare prefix", () => {
    expect(binaryCellsAsHex({ payload: { type: "Buffer", data: [] } })).toEqual({ payload: "\\x" });
  });

  test("leaves every other cell, a lookalike document included, as it was", () => {
    const doc = { type: "Buffer", data: [1, "two"] };
    const row = { name: "Ada", meta: { a: 1 }, doc, missing: null };

    const written = binaryCellsAsHex(row);

    expect(written).toEqual(row);
    expect(written.doc).toBe(doc);
  });

  // The CSV judges a cell, not what is nested inside one, and the JSON has to write
  // what the CSV writes: a sub-document's bytes stay as its own JSON spells them.
  test("judges the cell, not what is nested inside it, as the CSV does", () => {
    const nested = { file: { type: "Buffer", data: [1] } };

    expect(binaryCellsAsHex({ nested })).toEqual({ nested });
  });

  test("does not change the row it was handed", () => {
    const row = { payload: { type: "Buffer", data: [1] } };

    binaryCellsAsHex(row);

    expect(row.payload).toEqual({ type: "Buffer", data: [1] });
  });
});
