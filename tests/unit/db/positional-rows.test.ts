/**
 * A result row read positionally and keyed by the result's unique column names, so a
 * repeated or unnamed column keeps its own value.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { keyRowsByPosition } from "@/lib/db/utils/positional-rows";

describe("keyRowsByPosition", () => {
  test("each value lands under the name at its own position", () => {
    expect(
      keyRowsByPosition(
        ["a", "a (2)"],
        [
          [1, 2],
          [3, 4],
        ],
        "sqlite",
        "SELECT 1 AS a, 2 AS a",
      ),
    ).toEqual([
      { a: 1, "a (2)": 2 },
      { a: 3, "a (2)": 4 },
    ]);
    expect(keyRowsByPosition(["a"], [], "sqlite", "SELECT 1 AS a WHERE 0")).toEqual([]);
  });

  test("a column named __proto__ is an own key, not the row's prototype", () => {
    const [row] = keyRowsByPosition(["__proto__"], [[{ polluted: true }]], "sqlite", "SELECT 1");

    expect(Object.hasOwn(row, "__proto__")).toBe(true);
    expect((row as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("a row whose value count differs from the column count is refused, never padded or cut", () => {
    const read = () => keyRowsByPosition(["a", "b"], [[1, 2], [3]], "duckdb", "SELECT a, b FROM t");

    expect(read).toThrow(QueryError);
    expect(read).toThrow("Row 2 carries 1 values for 2 result columns");
  });
});
