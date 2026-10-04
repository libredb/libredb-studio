/**
 * Template values and composed filters (vector-family spec 5.4, E12, E26): an integer travels as `int64_val` built
 * from validated digits, never a JavaScript number, and ids travel as one template value, never concatenated.
 */
import { describe, expect, test } from "bun:test";
import {
  FILTER_IDENTIFIER,
  idsFilter,
  int64Digits,
  templateValue,
  templateValues,
} from "@/lib/db/providers/vector/milvus/expr";

describe("int64Digits (E12)", () => {
  test.each(["0", "5", "-1", "9007199254740993", "469489107428444015", "9223372036854775807", "-9223372036854775808"])(
    "keeps %s exactly",
    (text) => {
      expect(int64Digits(text)).toBe(text);
    },
  );

  // The seven malformed digit strings of E12: proto-loader would wrap or coerce each without an error (R40 M2).
  test.each(["9223372036854775808", "-9223372036854775809", "abc", "1.5", " 12", "007", "-0", "+5", "", "1e3"])(
    "refuses %j",
    (text) => {
      expect(int64Digits(text)).toBeUndefined();
    },
  );
});

describe("templateValue", () => {
  test.each([
    [{ kind: "bool", value: true }, { bool_val: true }],
    [{ kind: "int64", digits: "1152921504606846977" }, { int64_val: "1152921504606846977" }],
    [{ kind: "double", value: 1.5 }, { float_val: 1.5 }],
    [{ kind: "string", value: 'zz"] or pk in ["' }, { string_val: 'zz"] or pk in ["' }],
    [{ kind: "bool-array", values: [true, false] }, { array_val: { bool_data: { data: [true, false] } } }],
    [{ kind: "int64-array", values: ["1", "2"] }, { array_val: { long_data: { data: ["1", "2"] } } }],
    [{ kind: "double-array", values: [1, 2.5] }, { array_val: { double_data: { data: [1, 2.5] } } }],
    [{ kind: "string-array", values: ["a"] }, { array_val: { string_data: { data: ["a"] } } }],
  ] as const)("%j lowers to %j", (param, wire) => {
    expect(templateValue(param)).toEqual(wire);
  });

  test("templateValues builds a null-prototype map", () => {
    const values = templateValues({ v: { kind: "int64", digits: "7" } });
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect({ ...values }).toEqual({ v: { int64_val: "7" } });
  });
});

describe("idsFilter (E12, R45 F3)", () => {
  test("an Int64 key takes long_data", () => {
    const filter = idsFilter("id", { kind: "int64", values: ["469489107428444015"] });
    expect(filter.expr).toBe("id in {ids}");
    expect({ ...filter.values }).toEqual({ ids: { array_val: { long_data: { data: ["469489107428444015"] } } } });
  });

  test("a VarChar key takes string_data, and a crafted id stays one value", () => {
    const crafted = 'zz"] or pk in ["vc-0002';
    const filter = idsFilter("pk", { kind: "string", values: ["vc-0001", crafted] });
    expect(filter.expr).toBe("pk in {ids}");
    expect({ ...filter.values }).toEqual({ ids: { array_val: { string_data: { data: ["vc-0001", crafted] } } } });
  });

  test("a key that is not an identifier is a programming error, never a filter", () => {
    expect(() => idsFilter(" a", { kind: "int64", values: ["1"] })).toThrow(
      'The primary key " a" cannot be written bare in a filter',
    );
  });

  test("FILTER_IDENTIFIER is the collection-name rule", () => {
    expect(FILTER_IDENTIFIER.test("big_int")).toBe(true);
    expect(FILTER_IDENTIFIER.test("_x9")).toBe(true);
    expect(FILTER_IDENTIFIER.test("a b")).toBe(false);
    expect(FILTER_IDENTIFIER.test("9a")).toBe(false);
    expect(FILTER_IDENTIFIER.test("a".repeat(256))).toBe(false);
  });
});
