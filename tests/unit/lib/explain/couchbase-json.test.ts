import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";
import { couchbaseJsonStrategy } from "@/lib/explain/couchbase-json";
import type { ExplainTreeNode } from "@/lib/explain/types";

// Shape verified against a live Couchbase Server 8.0.2 node: the plan tree nests
// under both "~children" (array) and "~child" (single operator).
const PLAN = {
  "#operator": "Sequence",
  "~children": [
    {
      "#operator": "IndexScan3",
      index: "idx_hotel_city",
      keyspace: "hotel",
      scope: "inventory",
      bucket: "travel",
      using: "gsi",
    },
    { "#operator": "Fetch", keyspace: "hotel", scope: "inventory", bucket: "travel" },
    {
      "#operator": "Parallel",
      "~child": {
        "#operator": "Sequence",
        "~children": [{ "#operator": "InitialProject", result_terms: [{ expr: "self", star: true }] }],
      },
    },
  ],
};

function treeRoot(raw: unknown): ExplainTreeNode {
  const model = couchbaseJsonStrategy.toRenderModel(raw);
  expect(model?.kind).toBe("tree");
  return (model as { root: ExplainTreeNode }).root;
}

describe("couchbaseJsonStrategy", () => {
  test("format id", () => {
    expect(couchbaseJsonStrategy.format).toBe("couchbase-json");
  });

  test("is registered in the explain registry", () => {
    expect(getExplainStrategy("couchbase-json")).toBe(couchbaseJsonStrategy);
  });

  test("buildSql prefixes EXPLAIN in estimate mode", () => {
    expect(couchbaseJsonStrategy.buildSql("SELECT * FROM hotel", "estimate")).toBe("EXPLAIN SELECT * FROM hotel");
    expect(couchbaseJsonStrategy.buildSql("  SELECT 1", "estimate")).toBe("EXPLAIN   SELECT 1");
  });

  // SQL++ has no EXPLAIN ANALYZE, and ExplainStrategy emits SQL only so it cannot
  // reach the request-level profile parameter that would carry real timings. The
  // estimate is therefore returned for both modes, exactly as the SQLite strategy
  // does for EXPLAIN QUERY PLAN. Returning null for analyze instead would kill the
  // direct Explain action outright: use-query-execution.ts:165 builds that action
  // with mode "analyze" and refuses the run when the strategy declines it.
  test("buildSql returns the estimate plan in analyze mode, matching the SQLite strategy", () => {
    expect(couchbaseJsonStrategy.buildSql("SELECT * FROM hotel", "analyze")).toBe("EXPLAIN SELECT * FROM hotel");
  });

  test("buildSql declines a non-SELECT in analyze mode too", () => {
    expect(couchbaseJsonStrategy.buildSql("UPDATE hotel SET city = 'Bursa'", "analyze")).toBeNull();
  });

  test("buildSql returns null for non-SELECT statements", () => {
    expect(couchbaseJsonStrategy.buildSql("UPDATE hotel SET city = 'Bursa'", "estimate")).toBeNull();
    expect(couchbaseJsonStrategy.buildSql("EXPLAIN SELECT 1", "estimate")).toBeNull();
    expect(couchbaseJsonStrategy.buildSql("INFER `travel`", "estimate")).toBeNull();
  });

  test("extractPlan stores the plan carried by the EXPLAIN result row", () => {
    expect(couchbaseJsonStrategy.extractPlan({ rows: [{ plan: PLAN, text: "SELECT * FROM hotel" }] })).toEqual(PLAN);
  });

  test("extractPlan falls back to the raw rows when no plan field is present", () => {
    const rows = [{ nope: 1 }];
    expect(couchbaseJsonStrategy.extractPlan({ rows })).toEqual(rows);
    expect(couchbaseJsonStrategy.extractPlan({ rows: [] })).toEqual([]);
    expect(couchbaseJsonStrategy.extractPlan({})).toBeUndefined();
  });

  test("toRenderModel walks the operator tree, keeping the raw plan alongside it", () => {
    const model = couchbaseJsonStrategy.toRenderModel(PLAN);
    expect(model).toEqual({ kind: "tree", root: expect.anything(), raw: PLAN });
    const root = (model as { root: ExplainTreeNode }).root;
    expect(root.label).toBe("Sequence");
    expect(root.children.map((child) => child.label)).toEqual(["IndexScan3", "Fetch", "Parallel"]);
  });

  test("toRenderModel follows the single-operator ~child key, not just ~children", () => {
    const parallel = treeRoot(PLAN).children[2];
    expect(parallel.children.map((child) => child.label)).toEqual(["Sequence"]);
    expect(parallel.children[0].children.map((child) => child.label)).toEqual(["InitialProject"]);
  });

  test("toRenderModel puts keyspace path and index name in detail", () => {
    const children = treeRoot(PLAN).children;
    expect(children[0].detail).toBe("travel.inventory.hotel index: idx_hotel_city");
    expect(children[1].detail).toBe("travel.inventory.hotel");
    expect(children[2].detail).toBeUndefined();
    expect(treeRoot({ "#operator": "IndexScan3", index: "idx_city" }).detail).toBe("index: idx_city");
  });

  test("toRenderModel ignores tilde keys that do not carry operators", () => {
    const root = treeRoot({
      "#operator": "Sequence",
      "~versions": ["8.0.2"],
      "~children": [{ notAnOperator: true }, { "#operator": "Fetch" }],
    });
    expect(root.children.map((child) => child.label)).toEqual(["Fetch"]);
  });

  test("toRenderModel maps cost-based optimizer estimates onto estCost and estRows", () => {
    expect(treeRoot({ "#operator": "PrimaryScan3", cost: 12.5, cardinality: 3 }).metrics).toEqual({
      estCost: 12.5,
      estRows: 3,
    });
    expect(
      treeRoot({
        "#operator": "IndexScan3",
        optimizer_estimates: { cardinality: 187, cost: 20.32, fr_cost: 10.6, size: 25 },
      }).metrics,
    ).toEqual({ estCost: 20.32, estRows: 187 });
    expect(treeRoot({ "#operator": "Fetch", cost: 4 }).metrics).toEqual({ estCost: 4 });
  });

  test("toRenderModel omits metrics when estimates are absent, sentinel or non-numeric", () => {
    expect(treeRoot({ "#operator": "Fetch" }).metrics).toBeUndefined();
    // -1 is what Couchbase writes when the optimizer produced no estimate.
    expect(treeRoot({ "#operator": "Fetch", cost: -1, cardinality: -1 }).metrics).toBeUndefined();
    expect(treeRoot({ "#operator": "Fetch", cost: "cheap", cardinality: Number.NaN }).metrics).toBeUndefined();
    expect(
      treeRoot({ "#operator": "Fetch", optimizer_estimates: { cost: -1, cardinality: null } }).metrics,
    ).toBeUndefined();
    expect(treeRoot({ "#operator": "Fetch", optimizer_estimates: "none" }).metrics).toBeUndefined();
  });

  test("toRenderModel unwraps the EXPLAIN row shapes extractPlan may have stored", () => {
    expect(treeRoot({ plan: PLAN }).label).toBe("Sequence");
    expect(treeRoot([{ plan: PLAN }]).label).toBe("Sequence");
  });

  test("toRenderModel rejects shapes that are not Couchbase plans", () => {
    expect(couchbaseJsonStrategy.toRenderModel(null)).toBeNull();
    expect(couchbaseJsonStrategy.toRenderModel(undefined)).toBeNull();
    expect(couchbaseJsonStrategy.toRenderModel("EXPLAIN")).toBeNull();
    expect(couchbaseJsonStrategy.toRenderModel({})).toBeNull();
    expect(couchbaseJsonStrategy.toRenderModel([])).toBeNull();
    expect(couchbaseJsonStrategy.toRenderModel([{ id: 3, parent: 0, detail: "SCAN employee" }])).toBeNull();
    expect(couchbaseJsonStrategy.toRenderModel({ "#operator": 7 })).toBeNull();
    // Unwrapping is depth-bounded so a pathological wrapper chain cannot loop.
    expect(couchbaseJsonStrategy.toRenderModel({ plan: { plan: { plan: { plan: PLAN } } } })).toBeNull();
  });
});
