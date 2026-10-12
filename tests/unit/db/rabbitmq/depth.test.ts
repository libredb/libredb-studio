/**
 * The depth check every management answer passes after its parse: 64 levels are read, 65 are refused, and a nesting
 * far past any call stack is answered without a RangeError.
 */
import { describe, expect, test } from "bun:test";
import { nestsTooDeep } from "@/lib/db/providers/stream/rabbitmq/management/depth";

/** An array nested `depth` levels, built as text and parsed, as the client sees an answer. */
function nested(depth: number, open = "[", close = "]"): unknown {
  return JSON.parse(`${open.repeat(depth)}${close.repeat(depth)}`);
}

describe("nestsTooDeep", () => {
  test("reads 64 levels and refuses 65, for arrays and objects alike", () => {
    expect(nestsTooDeep(nested(64))).toBe(false);
    expect(nestsTooDeep(nested(65))).toBe(true);
    let object: unknown = {};
    for (let i = 1; i < 64; i++) object = { a: object };
    expect(nestsTooDeep(object)).toBe(false);
    expect(nestsTooDeep({ b: object })).toBe(true);
  });

  test("scalars and flat answers are never too deep", () => {
    for (const value of [null, 0, "x", true, [], {}, [1, "a", null], { a: 1 }]) expect(nestsTooDeep(value)).toBe(false);
  });

  test("a wide answer with one deep branch is refused by that branch", () => {
    const wide = Array.from({ length: 1000 }, () => ({ name: "q", type: "classic" }));
    expect(nestsTooDeep({ items: wide })).toBe(false);
    expect(nestsTooDeep({ items: [...wide, nested(63)] })).toBe(true);
  });

  test("100,000 levels are answered without a stack overflow", () => {
    expect(nestsTooDeep(nested(100_000))).toBe(true);
  });

  test("takes its limit as an argument", () => {
    expect(nestsTooDeep(nested(3), 3)).toBe(false);
    expect(nestsTooDeep(nested(4), 3)).toBe(true);
  });
});
