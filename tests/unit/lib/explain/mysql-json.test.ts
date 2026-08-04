import { describe, test, expect } from "bun:test";
import { mysqlJsonStrategy } from "@/lib/explain/mysql-json";

describe("mysqlJsonStrategy", () => {
  test("format id", () => {
    expect(mysqlJsonStrategy.format).toBe("mysql-json");
  });

  test("buildSql wraps SELECT with FORMAT=JSON explain in both modes", () => {
    expect(mysqlJsonStrategy.buildSql("SELECT * FROM t", "analyze")).toBe("EXPLAIN FORMAT=JSON SELECT * FROM t");
    expect(mysqlJsonStrategy.buildSql("SELECT * FROM t", "estimate")).toBe("EXPLAIN FORMAT=JSON SELECT * FROM t");
  });

  test("buildSql returns null for non-SELECT", () => {
    expect(mysqlJsonStrategy.buildSql("SHOW TABLES", "analyze")).toBeNull();
  });

  // Byte-for-byte legacy behavior: MySQL rows have no "QUERY PLAN" column, so
  // this falls back to raw rows (known bug B4, fixed in PR-4 with a real
  // query_block parser). Locked here so PR-4 shows an intentional diff.
  test("extractPlan falls back to raw rows for real MySQL output", () => {
    const rows = [{ EXPLAIN: '{"query_block":{}}' }];
    expect(mysqlJsonStrategy.extractPlan({ rows })).toEqual(rows);
  });

  // Both live-verified accepted through this exact prefix, and MySQL's EXPLAIN FORMAT=JSON describes without running,
  // so a CTE is safe to explain here - no write can hide inside one.
  test("buildSql explains a CTE and a commented SELECT", () => {
    const cte = "WITH t AS (SELECT 1 AS x) SELECT * FROM t";
    expect(mysqlJsonStrategy.buildSql(cte, "analyze")).toBe(`EXPLAIN FORMAT=JSON ${cte}`);
    expect(mysqlJsonStrategy.buildSql("-- note\nSELECT 1", "estimate")).toBe("EXPLAIN FORMAT=JSON -- note\nSELECT 1");
    expect(mysqlJsonStrategy.buildSql("/* note */ SELECT 1", "estimate")).toBe(
      "EXPLAIN FORMAT=JSON /* note */ SELECT 1",
    );
  });

  test("buildSql still declines a comment with no statement behind it", () => {
    expect(mysqlJsonStrategy.buildSql("-- only a comment", "analyze")).toBeNull();
    expect(mysqlJsonStrategy.buildSql("/* only a comment */", "analyze")).toBeNull();
  });
});
