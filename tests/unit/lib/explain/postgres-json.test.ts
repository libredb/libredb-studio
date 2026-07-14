import { describe, test, expect } from "bun:test";
import { postgresJsonStrategy } from "@/lib/explain/postgres-json";

describe("postgresJsonStrategy", () => {
  test("format id", () => {
    expect(postgresJsonStrategy.format).toBe("postgres-json");
  });

  test("buildSql wraps SELECT with ANALYZE JSON explain", () => {
    expect(postgresJsonStrategy.buildSql("SELECT * FROM users", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users",
    );
  });

  test("buildSql is case-insensitive and whitespace-tolerant", () => {
    expect(postgresJsonStrategy.buildSql("  select 1", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)   select 1",
    );
  });

  // PR-1 preserves current behavior: estimate mode also runs ANALYZE.
  // PR-5 (#194 B5) will make estimate return plain EXPLAIN (FORMAT JSON).
  test("buildSql estimate mode currently matches analyze mode", () => {
    expect(postgresJsonStrategy.buildSql("SELECT 1", "estimate")).toBe(
      postgresJsonStrategy.buildSql("SELECT 1", "analyze"),
    );
  });

  test("buildSql returns null for non-SELECT", () => {
    expect(postgresJsonStrategy.buildSql("UPDATE users SET a = 1", "analyze")).toBeNull();
    expect(postgresJsonStrategy.buildSql("EXPLAIN SELECT 1", "analyze")).toBeNull();
  });

  test("extractPlan prefers the QUERY PLAN column", () => {
    const plan = [{ Plan: { "Node Type": "Seq Scan" } }];
    expect(postgresJsonStrategy.extractPlan({ rows: [{ "QUERY PLAN": plan }] })).toEqual(plan);
  });

  test("extractPlan falls back to raw rows", () => {
    const rows = [{ id: 1 }];
    expect(postgresJsonStrategy.extractPlan({ rows })).toEqual(rows);
    expect(postgresJsonStrategy.extractPlan({})).toBeUndefined();
  });
});
