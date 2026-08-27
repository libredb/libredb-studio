import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";
import { duckdbJsonStrategy } from "@/lib/explain/duckdb-json";
import type { ExplainTreeNode } from "@/lib/explain/types";

/**
 * The exact bytes of the one result cell, captured from DuckDB v1.5.5 (@duckdb/node-api
 * 1.5.5-r.4) for
 * `EXPLAIN (FORMAT JSON) SELECT c.name, o.total FROM customers c JOIN orders o
 *  ON o.customer_id = c.id WHERE o.total > 10 ORDER BY o.total LIMIT 3`.
 *
 * Kept as TEXT rather than as an object literal because text is what the cell holds:
 * the envelope parse leaves this as a String and the plan needs a second parse, which
 * is the thing `extractPlan` exists to do.
 *
 * This statement was chosen over a simpler one because its plan carries, in one
 * payload, every hazard a hand-written fixture would have missed: an `extra_info`
 * value that is an ARRAY of strings (`Projections`) beside values that are plain
 * strings, a node (`TOP_N`) that publishes NO `Estimated Cardinality` at all, and
 * leaf nodes whose `children` is an empty array.
 */
const LIVE_JOIN_PLAN = `[
    {
        "name": "TOP_N",
        "children": [
            {
                "name": "HASH_JOIN",
                "children": [
                    {
                        "name": "SEQ_SCAN",
                        "children": [],
                        "extra_info": {
                            "Table": "warehouse.main.customers",
                            "Type": "Sequential Scan",
                            "Projections": [
                                "id",
                                "name"
                            ],
                            "Estimated Cardinality": "5"
                        }
                    },
                    {
                        "name": "SEQ_SCAN",
                        "children": [],
                        "extra_info": {
                            "Table": "warehouse.main.orders",
                            "Type": "Sequential Scan",
                            "Projections": [
                                "customer_id",
                                "total"
                            ],
                            "Estimated Cardinality": "1"
                        }
                    }
                ],
                "extra_info": {
                    "Join Type": "INNER",
                    "Conditions": "id = customer_id",
                    "Estimated Cardinality": "1"
                }
            }
        ],
        "extra_info": {
            "Top": "3",
            "Order By": "o.total ASC"
        }
    }
]`;

/**
 * The same cell for `EXPLAIN (FORMAT JSON) SELECT 1`, captured from the same build.
 * The `DUMMY_SCAN` leaf carries an `extra_info` that is present but EMPTY, which is
 * the shape that decides whether a node with nothing to say is still named.
 */
const LIVE_TRIVIAL_PLAN = `[
    {
        "name": "PROJECTION",
        "children": [
            {
                "name": "DUMMY_SCAN",
                "children": [],
                "extra_info": {}
            }
        ],
        "extra_info": {
            "Projections": "1",
            "Estimated Cardinality": "1"
        }
    }
]`;

/**
 * What `EXPLAIN (ANALYZE, FORMAT JSON)` answers on the runs where the profiler
 * declines to serialise its tree - measured verbatim on 1.5.5 for
 * `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO probe VALUES (42)` and for
 * `EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM customers` on a read-only
 * connection.
 *
 * The strategy never BUILDS that statement (see buildSql), so this payload can only
 * reach `toRenderModel` from a stored tab or an agent hydration. It is a record with
 * no `name`, so it must answer null rather than render a one-node tree labelled after
 * an error.
 */
const LIVE_ANALYZE_ERROR = `{
    "result": "error"
}`;

/** The one plan column of the one row; the row also carries `explain_key` (measured). */
const COLUMN = "explain_value";

function rowsFor(planText: unknown) {
  return { rows: [{ explain_key: "physical_plan", [COLUMN]: planText }] };
}

function treeOf(raw: unknown): ExplainTreeNode {
  const model = duckdbJsonStrategy.toRenderModel(raw);
  if (model === null || model.kind !== "tree") throw new Error("expected a tree render model");
  return model.root;
}

function labelsOf(node: ExplainTreeNode): string[] {
  return [node.label, ...node.children.flatMap(labelsOf)];
}

function findNode(node: ExplainTreeNode, label: string): ExplainTreeNode | undefined {
  if (node.label === label) return node;
  for (const child of node.children) {
    const hit = findNode(child, label);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe("duckdbJsonStrategy.buildSql", () => {
  test("wraps a SELECT in the JSON explain form", () => {
    expect(duckdbJsonStrategy.buildSql("SELECT 1", "estimate")).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
  });

  test("builds the planning form for analyze too, because DuckDB's ANALYZE really runs the statement", () => {
    // Measured on 1.5.5, in the only way that settles it: after
    // `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO probe VALUES (42)` the table held
    // one row, and after `EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET x = 2` the row
    // really was 2. The plain form is the opposite - `EXPLAIN (FORMAT JSON) INSERT
    // INTO probe VALUES (7)` left the count where it was.
    //
    // The mode is therefore ignored rather than declined: the direct Explain action
    // always builds with mode "analyze" and refuses the run when the strategy returns
    // null, so declining would switch the feature off instead of narrowing it, while
    // emitting the analyze form would run a statement the user only asked to see.
    expect(duckdbJsonStrategy.buildSql("SELECT 1", "analyze")).toBe(
      duckdbJsonStrategy.buildSql("SELECT 1", "estimate"),
    );
  });

  test("explains a CTE, which DuckDB plans without running", () => {
    expect(duckdbJsonStrategy.buildSql("WITH t AS (SELECT 1 AS a) SELECT * FROM t", "analyze")).toBe(
      "EXPLAIN (FORMAT JSON) WITH t AS (SELECT 1 AS a) SELECT * FROM t",
    );
  });

  test("explains a statement behind a leading comment", () => {
    expect(duckdbJsonStrategy.buildSql("-- note\nSELECT 1", "analyze")).toBe("EXPLAIN (FORMAT JSON) -- note\nSELECT 1");
  });

  test("declines a statement that is not a query", () => {
    expect(duckdbJsonStrategy.buildSql("INSERT INTO t VALUES (1)", "analyze")).toBeNull();
    expect(duckdbJsonStrategy.buildSql("CHECKPOINT", "analyze")).toBeNull();
    expect(duckdbJsonStrategy.buildSql("-- just a comment", "analyze")).toBeNull();
    expect(duckdbJsonStrategy.buildSql("", "analyze")).toBeNull();
  });
});

describe("duckdbJsonStrategy.extractPlan", () => {
  test("parses the plan out of the explain_value cell", () => {
    const plan = duckdbJsonStrategy.extractPlan(rowsFor(LIVE_JOIN_PLAN)) as Array<{ name: string }>;

    expect(Array.isArray(plan)).toBe(true);
    expect(plan).toHaveLength(1);
    expect(plan[0].name).toBe("TOP_N");
  });

  test("hands the rows through when the cell is not the plan text", () => {
    // Nothing recognisable: the raw tab must still show what the server sent rather
    // than an undefined.
    const rows = [{ other: 1 }];
    expect(duckdbJsonStrategy.extractPlan({ rows })).toBe(rows);
    expect(duckdbJsonStrategy.extractPlan({})).toBeUndefined();
    expect(duckdbJsonStrategy.extractPlan({ rows: [] })).toEqual([]);
  });

  test("keeps the text when it will not parse, so nothing is lost", () => {
    expect(duckdbJsonStrategy.extractPlan(rowsFor("not json"))).toBe("not json");
  });
});

describe("duckdbJsonStrategy.toRenderModel", () => {
  test("takes the single root out of the array DuckDB wraps the plan in", () => {
    // Measured: the parsed cell is an ARRAY, and it held exactly one node on all six
    // statements probed - a bare SELECT, a UNION ALL, two scalar subqueries, a
    // RECURSIVE CTE, a two-table join and a GROUP BY ... HAVING ... ORDER BY.
    const root = treeOf(duckdbJsonStrategy.extractPlan(rowsFor(LIVE_JOIN_PLAN)));

    expect(root.label).toBe("TOP_N (Top: 3 | Order By: o.total ASC)");
    expect(root.children).toHaveLength(1);
  });

  test("names a node by its operator and the extra_info that distinguishes it", () => {
    const labels = labelsOf(treeOf(duckdbJsonStrategy.extractPlan(rowsFor(LIVE_JOIN_PLAN))));

    // An array value is joined, the way DuckDB's own box renderer lists projections.
    expect(labels).toContain(
      "SEQ_SCAN (Table: warehouse.main.customers | Type: Sequential Scan | Projections: id, name)",
    );
    expect(labels).toContain("HASH_JOIN (Join Type: INNER | Conditions: id = customer_id)");
  });

  test("names a node with nothing to say by its operator alone", () => {
    // DUMMY_SCAN's extra_info is present and empty; a node may also carry none at all.
    expect(labelsOf(treeOf(duckdbJsonStrategy.extractPlan(rowsFor(LIVE_TRIVIAL_PLAN))))).toContain("DUMMY_SCAN");
    expect(treeOf([{ name: "SEQ_SCAN" }]).label).toBe("SEQ_SCAN");
  });

  test("drops an extra_info entry that describes nothing", () => {
    const root = treeOf([
      { name: "FILTER", extra_info: { Expression: "", Projections: [], Table: "t", "Table Index": 7 } },
    ]);

    // The empty string, the empty list and the non-textual value are all dropped -
    // keeping them would push the one entry that identifies the node off the row.
    expect(root.label).toBe("FILTER (Table: t)");
  });

  test("carries the planner's estimated cardinality as the row estimate", () => {
    // extra_info values are STRINGS on the wire ("5", not 5), so the number has to be
    // read out rather than assigned across.
    const root = treeOf(duckdbJsonStrategy.extractPlan(rowsFor(LIVE_JOIN_PLAN)));

    expect(findNode(root, "HASH_JOIN (Join Type: INNER | Conditions: id = customer_id)")!.metrics).toEqual({
      estRows: 1,
    });
    expect(
      findNode(root, "SEQ_SCAN (Table: warehouse.main.customers | Type: Sequential Scan | Projections: id, name)")!
        .metrics,
    ).toEqual({ estRows: 5 });
  });

  test("reports no metrics for a node that publishes no estimate", () => {
    // TOP_N really carries only `Top` and `Order By` in the measured plan. A zero here
    // would be a fabricated measurement, and there are never actual rows or timings to
    // show at all: the analyze form is never emitted.
    const root = treeOf(duckdbJsonStrategy.extractPlan(rowsFor(LIVE_JOIN_PLAN)));

    expect(root.metrics).toBeUndefined();
    expect(treeOf([{ name: "SEQ_SCAN", extra_info: { "Estimated Cardinality": "many" } }]).metrics).toBeUndefined();
  });

  test("keeps the raw value beside the tree, for the raw JSON and AI tabs", () => {
    const raw = duckdbJsonStrategy.extractPlan(rowsFor(LIVE_TRIVIAL_PLAN));

    expect(duckdbJsonStrategy.toRenderModel(raw)).toMatchObject({ kind: "tree", raw });
  });

  test("accepts the plan still unparsed, because an older tab may hold the cell text", () => {
    expect(labelsOf(treeOf(LIVE_TRIVIAL_PLAN))).toContain("DUMMY_SCAN");
  });

  test("shows every root when the array carries more than one", () => {
    // Not a shape measured on 1.5.5 - every probed statement planned to a single root
    // - but the wire type is an array, and dropping siblings silently would be worse
    // than naming a parent the engine did not send.
    const root = treeOf([{ name: "PROJECTION" }, { name: "DUMMY_SCAN" }]);

    expect(root.label).toBe("2 plans");
    expect(root.children.map((child) => child.label)).toEqual(["PROJECTION", "DUMMY_SCAN"]);
  });

  test("ignores an array entry that is not a plan node", () => {
    expect(treeOf([null, { name: "PROJECTION" }]).label).toBe("PROJECTION");
  });

  test("ignores a child that is not a plan node, and a children field that is not a list", () => {
    expect(treeOf([{ name: "PROJECTION", children: ["nope", { name: "SEQ_SCAN" }] }]).children.map((c) => c.label)) //
      .toEqual(["SEQ_SCAN"]);
    expect(treeOf([{ name: "PROJECTION", children: "nope" }]).children).toEqual([]);
  });

  test("returns null for the analyze payload DuckDB answers when profiling fails", () => {
    // `{"result":"error"}` is a real measured response of
    // `EXPLAIN (ANALYZE, FORMAT JSON)`. It is a record with no `name`, so it is not a
    // plan, and the honest answer is no tree rather than a node labelled after it.
    expect(duckdbJsonStrategy.toRenderModel(LIVE_ANALYZE_ERROR)).toBeNull();
    expect(duckdbJsonStrategy.toRenderModel(JSON.parse(LIVE_ANALYZE_ERROR))).toBeNull();
  });

  test("returns null for a shape that is not a DuckDB plan", () => {
    expect(duckdbJsonStrategy.toRenderModel(null)).toBeNull();
    expect(duckdbJsonStrategy.toRenderModel("not json")).toBeNull();
    expect(duckdbJsonStrategy.toRenderModel({})).toBeNull();
    expect(duckdbJsonStrategy.toRenderModel([])).toBeNull();
    expect(duckdbJsonStrategy.toRenderModel([{ operator: "SEQ_SCAN" }])).toBeNull();
    expect(duckdbJsonStrategy.toRenderModel(42)).toBeNull();
  });

  test("gives up rather than unwrapping text forever", () => {
    // The ceiling on the unwrap loop. One hop is the only legitimate one - the result
    // cell holds the plan as JSON text - so a value that stays a string past the
    // ceiling is not a plan, and answering null hides the Explain tab instead of
    // looping over a payload that never resolves.
    const nested = JSON.stringify(JSON.stringify(JSON.stringify(LIVE_TRIVIAL_PLAN)));

    expect(duckdbJsonStrategy.toRenderModel(nested)).toBeNull();
  });

  test("stops at a nesting ceiling rather than following a plan that never ends", () => {
    // Not a shape DuckDB emits - the deepest live plan measured here is nine nodes -
    // but the walk is recursive over server data, so the ceiling makes truncation
    // visible instead of letting a pathological payload run the stack out.
    let node: Record<string, unknown> = { name: "SEQ_SCAN", children: [] };
    for (let depth = 0; depth < 80; depth++) node = { name: "PROJECTION", children: [node] };
    const labels = labelsOf(treeOf([node]));

    expect(labels).toContain("plan truncated: nesting limit reached");
    expect(labels).not.toContain("SEQ_SCAN");
  });
});

describe("the explain registry", () => {
  test("resolves the duckdb-json format to this strategy", () => {
    expect(getExplainStrategy("duckdb-json")).toBe(duckdbJsonStrategy);
  });
});
