import { expect, test } from "bun:test";
import { hasResultOrder } from "@/lib/sql/result-order";

test.each([
  ["SELECT * FROM t ORDER BY id", true],
  ["SELECT * FROM t order /* comment */ by id", true],
  ["SELECT * FROM t ORDER -- note\nBY id", true],
  ["SELECT * FROM t", false],
  ["SELECT 'ORDER BY id' FROM t", false],
  ['SELECT "ORDER", "BY" FROM t', false],
  ["SELECT * FROM t -- ORDER BY id", false],
  ["SELECT * FROM t /* ORDER BY id */", false],
  ["SELECT row_number() OVER (ORDER BY id) FROM t", false],
  ["WITH x AS (SELECT * FROM t ORDER BY id) SELECT * FROM x", false],
  ["SELECT * FROM (SELECT * FROM t ORDER BY id) x ORDER BY id", true],
  ["SELECT * FROM t WHERE x[1] = 2", false],
  ["SELECT 'ORDER' BY id", false],
  ["SELECT * FROM t ORDER broken BY id", false],
])("outer result order: %s", (sql, expected) => {
  expect(hasResultOrder(sql as string, "postgres")).toBe(expected as boolean);
});

test("uses the connection's comment grammar", () => {
  expect(hasResultOrder("SELECT * FROM t # ORDER BY id", "mysql")).toBe(false);
  expect(hasResultOrder("SELECT * FROM #temp ORDER BY id", "mssql")).toBe(true);
});
