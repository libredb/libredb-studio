import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";
import { trinoJsonStrategy } from "@/lib/explain/trino-json";
import type { ExplainTreeNode } from "@/lib/explain/types";

/**
 * The exact bytes of the one result cell, captured from Trino 476 for
 * `EXPLAIN (FORMAT JSON) SELECT count(*) FROM tpch.sf1.nation`.
 *
 * Kept as TEXT rather than as an object literal because text is what the cell holds:
 * the envelope parse leaves this as a String and the plan needs a second parse, which
 * is the thing `extractPlan` exists to do. The shape is also the one that settled the
 * render model - TWO fragments, linked by a `RemoteSource` naming fragment 1, with the
 * scan in the second - and it carries the two hazards a hand-written fixture would
 * have missed: descriptor entries whose value is `""` or `"[]"` (Trino's own text
 * renderer drops those), and a cost that is the STRING "NaN" rather than a number.
 */
const LIVE_COUNT_PLAN = `{
  "0" : {
    "id" : "9",
    "name" : "Output",
    "descriptor" : {
      "columnNames" : "[_col0]"
    },
    "outputs" : [ {
      "type" : "bigint",
      "name" : "count"
    } ],
    "details" : [ "_col0 := count" ],
    "estimates" : [ {
      "outputRowCount" : 1.0,
      "outputSizeInBytes" : 9.0,
      "cpuCost" : 0.0,
      "memoryCost" : 0.0,
      "networkCost" : 0.0
    } ],
    "children" : [ {
      "id" : "4",
      "name" : "Aggregate",
      "descriptor" : {
        "type" : "FINAL",
        "keys" : "",
        "hash" : "[]"
      },
      "outputs" : [ {
        "type" : "bigint",
        "name" : "count"
      } ],
      "details" : [ "count := count(count_0)" ],
      "estimates" : [ {
        "outputRowCount" : 1.0,
        "outputSizeInBytes" : 9.0,
        "cpuCost" : 225.0,
        "memoryCost" : 9.0,
        "networkCost" : 0.0
      } ],
      "children" : [ {
        "id" : "183",
        "name" : "LocalExchange",
        "descriptor" : {
          "partitioning" : "SINGLE",
          "isReplicateNullsAndAny" : "",
          "hashColumn" : "[]",
          "arguments" : "[]"
        },
        "outputs" : [ {
          "type" : "bigint",
          "name" : "count_0"
        } ],
        "details" : [ ],
        "estimates" : [ {
          "outputRowCount" : 25.0,
          "outputSizeInBytes" : 225.0,
          "cpuCost" : 0.0,
          "memoryCost" : 0.0,
          "networkCost" : 0.0
        } ],
        "children" : [ {
          "id" : "189",
          "name" : "RemoteSource",
          "descriptor" : {
            "sourceFragmentIds" : "[1]"
          },
          "outputs" : [ {
            "type" : "bigint",
            "name" : "count_0"
          } ],
          "details" : [ ],
          "estimates" : [ ],
          "children" : [ ]
        } ]
      } ]
    } ]
  },
  "1" : {
    "id" : "187",
    "name" : "Aggregate",
    "descriptor" : {
      "type" : "PARTIAL",
      "keys" : "",
      "hash" : "[]"
    },
    "outputs" : [ {
      "type" : "bigint",
      "name" : "count_0"
    } ],
    "details" : [ "count_0 := count(*)" ],
    "estimates" : [ {
      "outputRowCount" : 25.0,
      "outputSizeInBytes" : 225.0,
      "cpuCost" : "NaN",
      "memoryCost" : "NaN",
      "networkCost" : "NaN"
    } ],
    "children" : [ {
      "id" : "0",
      "name" : "TableScan",
      "descriptor" : {
        "table" : "tpch:sf1:nation"
      },
      "outputs" : [ ],
      "details" : [ ],
      "estimates" : [ {
        "outputRowCount" : 25.0,
        "outputSizeInBytes" : 0.0,
        "cpuCost" : 0.0,
        "memoryCost" : 0.0,
        "networkCost" : 0.0
      } ],
      "children" : [ ]
    } ]
  }
}`;

/**
 * Captured from Trino 476 for `EXPLAIN (FORMAT JSON) SELECT 1 AS a` - the
 * single-fragment shape, and the one whose descriptor is an EMPTY object (`Values`).
 */
const LIVE_SINGLE_FRAGMENT_PLAN = `{
  "0" : {
    "id" : "5",
    "name" : "Output",
    "descriptor" : {
      "columnNames" : "[a]"
    },
    "outputs" : [ {
      "type" : "integer",
      "name" : "expr"
    } ],
    "details" : [ "a := expr" ],
    "estimates" : [ {
      "outputRowCount" : 1.0,
      "outputSizeInBytes" : 5.0,
      "cpuCost" : 0.0,
      "memoryCost" : 0.0,
      "networkCost" : 0.0
    } ],
    "children" : [ {
      "id" : "0",
      "name" : "Values",
      "descriptor" : { },
      "outputs" : [ {
        "type" : "integer",
        "name" : "expr"
      } ],
      "details" : [ "(integer '1')" ],
      "estimates" : [ {
        "outputRowCount" : 1.0,
        "outputSizeInBytes" : 5.0,
        "cpuCost" : 0.0,
        "memoryCost" : 0.0,
        "networkCost" : 0.0
      } ],
      "children" : [ ]
    } ]
  }
}`;

/** The one column of the one row, named exactly this on the wire (measured). */
const COLUMN = "Query Plan";

function rowsFor(planText: string) {
  return { rows: [{ [COLUMN]: planText }] };
}

function treeOf(raw: unknown): ExplainTreeNode {
  const model = trinoJsonStrategy.toRenderModel(raw);
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

describe("trinoJsonStrategy.buildSql", () => {
  test("wraps a SELECT in the JSON explain form", () => {
    expect(trinoJsonStrategy.buildSql("SELECT 1", "estimate")).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
  });

  test("builds the same statement for analyze, because Trino's EXPLAIN never executes", () => {
    // Measured on 476, and this is the whole reason `EXPLAIN ANALYZE` is not emitted
    // here: `EXPLAIN (FORMAT JSON) INSERT INTO memory.default.probe VALUES (42)`
    // FINISHED and the table still held 0 rows, while `EXPLAIN ANALYZE INSERT INTO
    // memory.default.probe VALUES (7)` took the row count from 0 to 1. The direct
    // Explain action always builds with mode "analyze" (use-query-execution.ts), so
    // returning null there would disable the feature, and emitting EXPLAIN ANALYZE
    // would run the statement the user only asked to see.
    expect(trinoJsonStrategy.buildSql("SELECT 1", "analyze")).toBe(trinoJsonStrategy.buildSql("SELECT 1", "estimate"));
  });

  test("explains a CTE, which Trino plans without running", () => {
    expect(trinoJsonStrategy.buildSql("WITH t AS (SELECT 1 AS a) SELECT * FROM t", "analyze")).toBe(
      "EXPLAIN (FORMAT JSON) WITH t AS (SELECT 1 AS a) SELECT * FROM t",
    );
  });

  test("explains a statement behind a leading comment", () => {
    expect(trinoJsonStrategy.buildSql("-- note\nSELECT 1", "analyze")).toBe("EXPLAIN (FORMAT JSON) -- note\nSELECT 1");
  });

  test("reads a block comment FLAT, the way Trino does", () => {
    // The dialect fact this strategy passes the grammar for. Measured on 476:
    // `SELECT /* a /* b */ 1 AS a` returns the column, so the first `*/` closed the
    // run and what follows is the statement. A nesting reader would see the whole
    // rest as comment text and refuse to classify - hiding the Explain button on a
    // statement Trino explains perfectly well.
    expect(trinoJsonStrategy.buildSql("/* a /* b */ SELECT 1", "analyze")).toBe(
      "EXPLAIN (FORMAT JSON) /* a /* b */ SELECT 1",
    );
  });

  test("declines a statement that is not a query", () => {
    expect(trinoJsonStrategy.buildSql("INSERT INTO t VALUES (1)", "analyze")).toBeNull();
    expect(trinoJsonStrategy.buildSql("SHOW CATALOGS", "analyze")).toBeNull();
    expect(trinoJsonStrategy.buildSql("-- just a comment", "analyze")).toBeNull();
    expect(trinoJsonStrategy.buildSql("", "analyze")).toBeNull();
  });
});

describe("trinoJsonStrategy.extractPlan", () => {
  test("parses the plan out of the Query Plan cell", () => {
    const plan = trinoJsonStrategy.extractPlan(rowsFor(LIVE_COUNT_PLAN)) as Record<string, { name: string }>;
    expect(Object.keys(plan)).toEqual(["0", "1"]);
    expect(plan["0"].name).toBe("Output");
    expect(plan["1"].name).toBe("Aggregate");
  });

  test("hands the rows through when the cell is not the plan text", () => {
    // Nothing recognisable: the raw tab must still show what the server sent rather
    // than an undefined.
    const rows = [{ other: 1 }];
    expect(trinoJsonStrategy.extractPlan({ rows })).toBe(rows);
    expect(trinoJsonStrategy.extractPlan({})).toBeUndefined();
  });

  test("keeps the text when it will not parse, so nothing is lost", () => {
    expect(trinoJsonStrategy.extractPlan(rowsFor("not json"))).toBe("not json");
  });
});

describe("trinoJsonStrategy.toRenderModel", () => {
  test("builds one subtree per fragment, in numeric order under a synthetic root", () => {
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_COUNT_PLAN)));

    expect(root.label).toBe("2 fragments");
    expect(root.children.map((child) => child.label)).toEqual(["Fragment 0", "Fragment 1"]);
  });

  test("renders a node the way Trino's own text plan names it", () => {
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_COUNT_PLAN)));

    // Trino's text EXPLAIN of the same statement writes `Output[columnNames =
    // [_col0]]`, `Aggregate[type = FINAL]` and `TableScan[table = tpch:sf1:nation]`,
    // and the descriptor entries it drops there (`keys` is `""`, `hash` is `"[]"`) are
    // dropped here too - an empty value describes nothing and would crowd out the one
    // that does.
    const labels = labelsOf(root);
    expect(labels).toContain("Output[columnNames = [_col0]]");
    expect(labels).toContain("Aggregate[type = FINAL]");
    expect(labels).toContain("TableScan[table = tpch:sf1:nation]");
    expect(labels).toContain("LocalExchange[partitioning = SINGLE]");
    expect(labels).toContain("RemoteSource[sourceFragmentIds = [1]]");
  });

  test("a node with an empty descriptor is named by itself alone", () => {
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_SINGLE_FRAGMENT_PLAN)));

    expect(labelsOf(root)).toContain("Values");
  });

  test("keeps the single fragment's own subtree when there is only one", () => {
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_SINGLE_FRAGMENT_PLAN)));

    expect(root.label).toBe("Fragment 0");
    expect(root.children).toHaveLength(1);
  });

  test("carries the planner's own estimates as metrics", () => {
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_COUNT_PLAN)));

    expect(findNode(root, "Aggregate[type = FINAL]")!.metrics).toEqual({ estRows: 1, estCost: 225 });
    expect(findNode(root, "TableScan[table = tpch:sf1:nation]")!.metrics).toEqual({ estRows: 25, estCost: 0 });
  });

  test("drops a cost the planner could not compute instead of reading NaN as a number", () => {
    // Measured: the PARTIAL aggregate's estimates carry `"cpuCost" : "NaN"` - a JSON
    // STRING, not a number - because the fragment's inputs are not known when it is
    // costed. Row count is still real, so the node keeps that and loses only the cost.
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_COUNT_PLAN)));

    expect(findNode(root, "Aggregate[type = PARTIAL]")!.metrics).toEqual({ estRows: 25 });
  });

  test("carries the node's own details line as its detail", () => {
    const root = treeOf(trinoJsonStrategy.extractPlan(rowsFor(LIVE_COUNT_PLAN)));

    expect(findNode(root, "Aggregate[type = FINAL]")!.detail).toBe("count := count(count_0)");
    expect(findNode(root, "LocalExchange[partitioning = SINGLE]")!.detail).toBeUndefined();
  });

  test("keeps the raw value beside the tree, for the raw JSON and AI tabs", () => {
    const raw = trinoJsonStrategy.extractPlan(rowsFor(LIVE_SINGLE_FRAGMENT_PLAN));
    const model = trinoJsonStrategy.toRenderModel(raw);

    expect(model).toMatchObject({ kind: "tree", raw });
  });

  test("accepts the plan still unparsed, because an older tab may hold the cell text", () => {
    expect(treeOf(LIVE_SINGLE_FRAGMENT_PLAN).label).toBe("Fragment 0");
  });

  test("returns null for a shape that is not a Trino plan", () => {
    expect(trinoJsonStrategy.toRenderModel(null)).toBeNull();
    expect(trinoJsonStrategy.toRenderModel("not json")).toBeNull();
    expect(trinoJsonStrategy.toRenderModel({})).toBeNull();
    expect(trinoJsonStrategy.toRenderModel([{ name: "Output" }])).toBeNull();
    expect(trinoJsonStrategy.toRenderModel({ "0": { id: "1" } })).toBeNull();
  });

  test("gives up rather than unwrapping text forever", () => {
    // The ceiling on the unwrap loop. One hop is the only legitimate one - the result
    // cell holds the plan as JSON text - so a value that stays a string past the
    // ceiling is not a plan, and answering null hides the Explain tab instead of
    // looping over a payload that never resolves to an object.
    const nested = JSON.stringify(JSON.stringify(JSON.stringify(LIVE_SINGLE_FRAGMENT_PLAN)));

    expect(trinoJsonStrategy.toRenderModel(nested)).toBeNull();
  });

  test("orders fragments numerically, not lexicographically", () => {
    // `Object.keys` hands them back in insertion order and a string sort would put
    // fragment 10 between 1 and 2. A ten-fragment plan is ordinary on a join-heavy
    // statement, so this is a real ordering and not a synthetic one.
    const many: Record<string, unknown> = {};
    for (const id of ["2", "10", "1"]) many[id] = { id, name: "Output", children: [] };
    const root = treeOf(many);

    expect(root.children.map((child) => child.label)).toEqual(["Fragment 1", "Fragment 2", "Fragment 10"]);
  });

  test("stops at a nesting ceiling rather than following a plan that never ends", () => {
    // Not a shape Trino emits - the deepest live plan here is four nodes - but the
    // walk is recursive over server data, so the ceiling makes truncation visible
    // instead of letting a pathological payload run the stack out.
    let node: Record<string, unknown> = { name: "TableScan", children: [] };
    for (let depth = 0; depth < 80; depth++) node = { name: "Project", children: [node] };
    const labels = labelsOf(treeOf({ "0": node }));

    expect(labels).toContain("plan truncated: nesting limit reached");
    expect(labels).not.toContain("TableScan");
  });
});

describe("the explain registry", () => {
  test("resolves the trino-json format to this strategy", () => {
    expect(getExplainStrategy("trino-json")).toBe(trinoJsonStrategy);
  });
});
