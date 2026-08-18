import { describe, test, expect } from "bun:test";
import { jsonText } from "@/lib/export/json";

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
