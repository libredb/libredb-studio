import { describe, test, expect } from "bun:test";
import { postgresTextStrategy, postgresTextAnalyzeStrategy } from "@/lib/explain/postgres-text";
import type { ExplainTreeNode } from "@/lib/explain/types";

/**
 * Measured 2026-09-06 on Materialize v26.40.0 (`materialize/materialized:v26.40.0`),
 * one row whose single cell carries the whole plan as newline-separated text.
 */
const MATERIALIZE_ROWS = [
  {
    "Physical Plan": [
      "Explained Query:",
      "  →Accumulable GroupAggregate",
      "    Simple aggregates: sum(#0{amount})",
      "    →Differential Join %0:orders[#0{cust}] » %1:customers[#0{id}]",
      "      →Arrange (#0{cust})",
      "        →Read materialize.public.orders",
      "",
      "Target cluster: quickstart",
      "",
    ].join("\n"),
  },
];

/**
 * Measured 2026-09-06 on CockroachDB v26.2.5 (`cockroachdb/cockroach:v26.2.5`), one
 * row per plan line in a column called `info`, the tree drawn with box glyphs and
 * every plan node marked with a bullet.
 */
const COCKROACH_ROWS = [
  { info: "distribution: local" },
  { info: "" },
  { info: "• group (hash)" },
  { info: "│ group by: name" },
  { info: "│" },
  { info: "└── • hash join" },
  { info: "    │ equality: (id) = (cust)" },
  { info: "    │" },
  { info: "    ├── • scan" },
  { info: "    │     table: customers@customers_pkey" },
  { info: "    │" },
  { info: "    └── • filter" },
  { info: "        │ filter: amount > 10" },
];

function asTree(raw: unknown): ExplainTreeNode {
  const model = postgresTextStrategy.toRenderModel(raw);
  if (model === null || model.kind !== "tree") throw new Error("expected a tree render model");
  return model.root;
}

function labels(node: ExplainTreeNode): string[] {
  return [node.label, ...node.children.flatMap(labels)];
}

describe("postgresTextStrategy.buildSql", () => {
  test("asks for a plain EXPLAIN in both modes, because the engine that needs this grammar has no ANALYZE", () => {
    expect(postgresTextStrategy.buildSql("SELECT 1", "estimate")).toBe("EXPLAIN SELECT 1");
    expect(postgresTextStrategy.buildSql("SELECT 1", "analyze")).toBe("EXPLAIN SELECT 1");
  });

  test("refuses a statement PostgreSQL's grammar does not explain", () => {
    expect(postgresTextStrategy.buildSql("UPDATE t SET a = 1", "analyze")).toBeNull();
  });

  test("refuses a data-modifying CTE, the screen postgres-json applies for the same reason", () => {
    expect(
      postgresTextStrategy.buildSql("WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x", "analyze"),
    ).toBeNull();
  });
});

describe("postgresTextAnalyzeStrategy.buildSql", () => {
  test("asks for real timings only when the caller asked to analyze", () => {
    expect(postgresTextAnalyzeStrategy.buildSql("SELECT 1", "analyze")).toBe("EXPLAIN ANALYZE SELECT 1");
    expect(postgresTextAnalyzeStrategy.buildSql("SELECT 1", "estimate")).toBe("EXPLAIN SELECT 1");
  });

  test("applies the same screen, because EXPLAIN ANALYZE runs what it explains", () => {
    expect(postgresTextAnalyzeStrategy.buildSql("DELETE FROM t", "analyze")).toBeNull();
  });

  test("reads a plan the same way as the plain-EXPLAIN strategy", () => {
    expect(postgresTextAnalyzeStrategy.toRenderModel(COCKROACH_ROWS)).toEqual(
      postgresTextStrategy.toRenderModel(COCKROACH_ROWS),
    );
  });
});

describe("postgresTextStrategy.extractPlan", () => {
  test("keeps the rows as the engine printed them", () => {
    expect(postgresTextStrategy.extractPlan({ rows: COCKROACH_ROWS })).toEqual(COCKROACH_ROWS);
  });

  test("a result with no rows at all is an empty plan, not a crash", () => {
    expect(postgresTextStrategy.extractPlan({})).toEqual([]);
  });
});

describe("postgresTextStrategy.toRenderModel - one cell holding the whole plan", () => {
  test("splits the cell into a tree, so a plan Materialize prints whole still nests", () => {
    const root = asTree(MATERIALIZE_ROWS);
    expect(root.label).toBe("EXPLAIN");
    expect(root.children.map((c) => c.label)).toEqual(["Explained Query:", "Target cluster: quickstart"]);
    const query = root.children[0];
    expect(query.children.map((c) => c.label)).toEqual(["→Accumulable GroupAggregate"]);
    expect(query.children[0].children.map((c) => c.label)).toEqual([
      "Simple aggregates: sum(#0{amount})",
      "→Differential Join %0:orders[#0{cust}] » %1:customers[#0{id}]",
    ]);
  });

  test("the raw tab shows the plan text the engine printed, blank padding dropped", () => {
    const model = postgresTextStrategy.toRenderModel(MATERIALIZE_ROWS);
    if (model === null || model.kind !== "tree") throw new Error("expected a tree render model");
    expect(model.raw).toBe(
      [
        "Explained Query:",
        "  →Accumulable GroupAggregate",
        "    Simple aggregates: sum(#0{amount})",
        "    →Differential Join %0:orders[#0{cust}] » %1:customers[#0{id}]",
        "      →Arrange (#0{cust})",
        "        →Read materialize.public.orders",
        "Target cluster: quickstart",
      ].join("\n"),
    );
  });
});

describe("postgresTextStrategy.toRenderModel - one row per plan line", () => {
  test("a bulleted node's attribute lines become its detail, not children under it", () => {
    const root = asTree(COCKROACH_ROWS);
    const group = root.children.find((c) => c.label === "• group (hash)");
    expect(group?.detail).toBe("group by: name");
    expect(group?.children.map((c) => c.label)).toEqual(["• hash join"]);
  });

  test("a connector's width is the depth, so the two scans are siblings under the join", () => {
    const root = asTree(COCKROACH_ROWS);
    expect(labels(root)).toEqual([
      "EXPLAIN",
      "distribution: local",
      "• group (hash)",
      "• hash join",
      "• scan",
      "• filter",
    ]);
  });

  test("every attribute of a node is kept, joined", () => {
    const rows = [{ info: "• scan" }, { info: "│ table: orders@orders_pkey" }, { info: "│ spans: FULL SCAN" }];
    expect(asTree(rows).detail).toBe("table: orders@orders_pkey, spans: FULL SCAN");
  });

  test("a line before the first bulleted node stays a node of its own", () => {
    const root = asTree(COCKROACH_ROWS);
    expect(root.children[0]).toEqual({ label: "distribution: local", children: [] });
  });
});

describe("postgresTextStrategy.toRenderModel - shapes it must not read", () => {
  test.each([
    ["a foreign value", 42],
    ["no rows", []],
    ["a postgres-json plan", [{ Plan: { "Node Type": "Seq Scan" } }]],
    ["rows that are not records", [["• scan"]]],
    ["rows whose cells are all blank", [{ info: "" }, { info: "   " }]],
  ])("%s reads as no plan", (_name, raw) => {
    expect(postgresTextStrategy.toRenderModel(raw)).toBeNull();
  });
});
