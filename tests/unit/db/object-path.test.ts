import { describe, test, expect } from "bun:test";
import { comparePaths, pathKey } from "@/lib/db/object-path";

/**
 * The hoisted comparator, and the arms sixteen provider-local copies never had a test for.
 *
 * Task 28a's brief carries the measurement that makes this file necessary: raw lcov reported
 * 36 hits on the length comparison of one of those copies while mutating that comparison to
 * `return 0` failed ZERO tests. A line reported covered and dead under mutation is standing
 * ruling 5b's trap, and hoisting sixteen unmutated copies into one unmutated copy would have
 * moved it rather than closed it. Every arm below is written so that deleting the arm it is
 * about turns it red, and the report records the mutation run.
 */
describe("comparePaths", () => {
  test("orders SEGMENT BY SEGMENT and never by one joined string", () => {
    expect(comparePaths(["a", "b"], ["a", "c"])).toBeLessThan(0);
    expect(comparePaths(["a", "c"], ["a", "b"])).toBeGreaterThan(0);
    expect(comparePaths(["a", "b"], ["a", "b"])).toBe(0);
  });

  test("a separator inside a segment does not reorder against a shorter first segment", () => {
    // `JSON.stringify` would compare `["a","z"]` against `["b","a"]` as text and still answer
    // the same way here, but it reorders the pair below: `"` (0x22) and `\` (0x5C) are
    // rewritten by the escape, so the order becomes the escape sequences' rather than the
    // characters'.
    expect(comparePaths(["a", "z"], ["b", "a"])).toBeLessThan(0);
    expect(comparePaths(['a"b'], ["a\\b"])).toBeLessThan(0);
  });

  /**
   * THE MIXED-DEPTH ARM, which is the one the brief measured dead.
   *
   * A prefix sorts ABOVE the paths nested under it, which is what puts an Oracle
   * schema-level trigger above the table-level ones and a container-level row above its
   * own children. `JSON.stringify` answers the reverse, because `,` (0x2C) is below `]`
   * (0x5D), and a comparator that returned 0 here would leave the two in whatever order the
   * rows arrived in.
   */
  test("a prefix sorts above a path that extends it, at every depth", () => {
    expect(comparePaths(["a"], ["a", "b"])).toBeLessThan(0);
    expect(comparePaths(["a", "b"], ["a"])).toBeGreaterThan(0);
    expect(comparePaths([], ["a"])).toBeLessThan(0);
    expect(comparePaths(["a"], [])).toBeGreaterThan(0);
    expect(comparePaths([], [])).toBe(0);
    // Two levels apart, so a comparator returning the sign of a single missing segment is
    // not enough: the magnitude is the depth difference and the sign is what is asserted.
    expect(comparePaths(["a"], ["a", "b", "c"])).toBeLessThan(0);
  });

  test("sorting a mixed-depth listing puts each prefix above its own children", () => {
    const listing = [["app", "orders", "orders_stamp"], ["app", "orders"], ["app"], ["app", "customers"]];
    expect([...listing].sort(comparePaths)).toEqual([
      ["app"],
      ["app", "customers"],
      ["app", "orders"],
      ["app", "orders", "orders_stamp"],
    ]);
  });

  /**
   * UTF-16 code units, deliberately, and this test is the record of that decision.
   *
   * Task 26a-2 measured four engines cutting a bounded read under the UTF-8 BYTE order while
   * this comparator compares UTF-16 code units, and the two answer the REVERSE for `U+E000`
   * against `U+1F600`: in UTF-8 the bytes are `ee 80 80` against `f0 9f 98 80`, so `U+E000`
   * is first, while in UTF-16 `U+1F600` is the surrogate pair `D83D DE00` and `U+E000` sorts
   * ABOVE it. The hoisted function keeps the UTF-16 answer; the docblock says why. This test
   * pins the pair so that a later change to byte order cannot land as a silent side effect.
   */
  test("compares UTF-16 code units, which reverses U+E000 against U+1F600", () => {
    expect(comparePaths(["\u{1F600}"], ["\u{E000}"])).toBeLessThan(0);
    expect(comparePaths(["\u{E000}"], ["\u{1F600}"])).toBeGreaterThan(0);
  });
});

describe("pathKey", () => {
  test("two different paths cannot produce one key", () => {
    // The separator is a control character no engine here allows inside an identifier, so the
    // segment boundary survives the join. Splitting on a dot or a slash would make
    // `["a.b"]` and `["a", "b"]` one key.
    expect(pathKey(["a.b"])).not.toBe(pathKey(["a", "b"]));
    expect(pathKey(["a/b"])).not.toBe(pathKey(["a", "b"]));
    expect(pathKey(["a", "b"])).toBe(pathKey(["a", "b"]));
  });

  test("the key is the segments themselves, not an escaped spelling of them", () => {
    // `JSON.stringify` is what this replaces: it rewrites a quote and a backslash, so a key
    // built here and a key built by another reader would only agree on ordinary names.
    expect(pathKey(['a"b'])).toBe('a"b');
    expect(pathKey([])).toBe("");
  });
});
