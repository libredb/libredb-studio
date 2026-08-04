import { describe, test, expect } from "bun:test";
import { sqliteQueryplanStrategy } from "@/lib/explain/sqlite-queryplan";
import type { ExplainTreeNode } from "@/lib/explain/types";

const ROWS = [
  { id: 3, parent: 0, notused: 0, detail: "SCAN employee" },
  { id: 8, parent: 3, notused: 0, detail: "USING INDEX idx_dept" },
  { id: 12, parent: 0, notused: 0, detail: "USE TEMP B-TREE FOR ORDER BY" },
];

describe("sqliteQueryplanStrategy", () => {
  test("format id", () => {
    expect(sqliteQueryplanStrategy.format).toBe("sqlite-queryplan");
  });

  test("buildSql wraps SELECT identically in both modes (EXPLAIN QUERY PLAN never executes)", () => {
    expect(sqliteQueryplanStrategy.buildSql("SELECT * FROM employee", "estimate")).toBe(
      "EXPLAIN QUERY PLAN SELECT * FROM employee",
    );
    expect(sqliteQueryplanStrategy.buildSql("SELECT * FROM employee", "analyze")).toBe(
      "EXPLAIN QUERY PLAN SELECT * FROM employee",
    );
  });

  test("buildSql returns null for non-SELECT", () => {
    expect(sqliteQueryplanStrategy.buildSql("PRAGMA table_info(t)", "estimate")).toBeNull();
    expect(sqliteQueryplanStrategy.buildSql("EXPLAIN QUERY PLAN SELECT 1", "estimate")).toBeNull();
  });

  test("extractPlan stores the raw rows", () => {
    expect(sqliteQueryplanStrategy.extractPlan({ rows: ROWS })).toEqual(ROWS);
    expect(sqliteQueryplanStrategy.extractPlan({})).toBeUndefined();
  });

  test("toRenderModel builds a parent-pointer tree under a synthetic root", () => {
    const model = sqliteQueryplanStrategy.toRenderModel(ROWS);
    expect(model?.kind).toBe("tree");
    const root = (model as { root: ExplainTreeNode }).root;
    expect(root.label).toBe("Query Plan");
    expect(root.children.map((c) => c.label)).toEqual(["SCAN employee", "USE TEMP B-TREE FOR ORDER BY"]);
    expect(root.children[0].children[0].label).toBe("USING INDEX idx_dept");
    expect(root.children[0].children[0].metrics).toBeUndefined();
  });

  test("toRenderModel attaches orphaned parents to the root and survives cycles", () => {
    const orphan = [{ id: 5, parent: 99, notused: 0, detail: "ORPHAN" }];
    expect(sqliteQueryplanStrategy.toRenderModel(orphan)?.kind).toBe("tree");
    const cyc = [
      { id: 1, parent: 2, notused: 0, detail: "A" },
      { id: 2, parent: 1, notused: 0, detail: "B" },
    ];
    const model = sqliteQueryplanStrategy.toRenderModel(cyc);
    expect(model?.kind).toBe("tree"); // must terminate, not recurse forever
  });

  test("toRenderModel rejects foreign shapes", () => {
    expect(sqliteQueryplanStrategy.toRenderModel(null)).toBeNull();
    expect(sqliteQueryplanStrategy.toRenderModel([])).toBeNull();
    expect(sqliteQueryplanStrategy.toRenderModel([{ nope: 1 }])).toBeNull();
  });

  // Both live-verified accepted through this exact prefix, and EXPLAIN QUERY PLAN describes without running,
  // so a CTE is safe to explain here - no write can hide inside one.
  test("buildSql explains a CTE and a commented SELECT", () => {
    const cte = "WITH t AS (SELECT 1 AS x) SELECT * FROM t";
    expect(sqliteQueryplanStrategy.buildSql(cte, "analyze")).toBe(`EXPLAIN QUERY PLAN ${cte}`);
    expect(sqliteQueryplanStrategy.buildSql("-- note\nSELECT 1", "estimate")).toBe(
      "EXPLAIN QUERY PLAN -- note\nSELECT 1",
    );
    expect(sqliteQueryplanStrategy.buildSql("/* note */ SELECT 1", "estimate")).toBe(
      "EXPLAIN QUERY PLAN /* note */ SELECT 1",
    );
  });

  test("buildSql still declines a comment with no statement behind it", () => {
    expect(sqliteQueryplanStrategy.buildSql("-- only a comment", "analyze")).toBeNull();
    expect(sqliteQueryplanStrategy.buildSql("/* only a comment */", "analyze")).toBeNull();
  });
});
