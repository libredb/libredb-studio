import { describe, test, expect } from "bun:test";
import { mysqlTextStrategy } from "@/lib/explain/mysql-text";
import type { ExplainTreeNode } from "@/lib/explain/types";

// TiDB v8.5.1, 2026-09-06, mysql2 text protocol: `EXPLAIN SELECT c.country,
// SUM(o.amount) ... JOIN ... GROUP BY c.country ORDER BY total DESC` answered five
// columns (id, estRows, task, access object, operator info) and ten rows, the tree
// carried in the `id` column as box glyphs plus two-space indents.
const TIDB_JOIN_ROWS = [
  { id: "Sort_10", estRows: "4162.50", task: "root", "access object": "", "operator info": "Column#6:desc" },
  {
    id: "└─Projection_12",
    estRows: "4162.50",
    task: "root",
    "access object": "",
    "operator info": "test.probe_wire_customers.country, Column#6",
  },
  {
    id: "  └─HashAgg_13",
    estRows: "4162.50",
    task: "root",
    "access object": "",
    "operator info": "group by:Column#8, funcs:sum(Column#7)->Column#6",
  },
  {
    id: "    └─Projection_31",
    estRows: "4162.50",
    task: "root",
    "access object": "",
    "operator info": "cast(test.probe_wire_orders.amount, decimal(10,0) BINARY)->Column#7",
  },
  {
    id: "      └─HashJoin_24",
    estRows: "4162.50",
    task: "root",
    "access object": "",
    "operator info": "inner join, equal:[eq(test.probe_wire_orders.customer_id, test.probe_wire_customers.id)]",
  },
  {
    id: "        ├─TableReader_27(Build)",
    estRows: "3330.00",
    task: "root",
    "access object": "",
    "operator info": "data:Selection_26",
  },
  {
    id: "        │ └─Selection_26",
    estRows: "3330.00",
    task: "cop[tikv]",
    "access object": "",
    "operator info": "gt(test.probe_wire_orders.amount, 5)",
  },
  {
    id: "        │   └─TableFullScan_25",
    estRows: "10000.00",
    task: "cop[tikv]",
    "access object": "table:o",
    "operator info": "keep order:false, stats:pseudo",
  },
  {
    id: "        └─TableReader_29(Probe)",
    estRows: "10000.00",
    task: "root",
    "access object": "",
    "operator info": "data:TableFullScan_28",
  },
  {
    id: "          └─TableFullScan_28",
    estRows: "10000.00",
    task: "cop[tikv]",
    "access object": "table:c",
    "operator info": "keep order:false, stats:pseudo",
  },
];

// StarRocks 3.3.22, 2026-09-06: `EXPLAIN SELECT 1` answered one column named
// `Explain String` and thirteen rows, two of them empty strings.
const STARROCKS_SELECT1_ROWS = [
  { "Explain String": "EXECUTE IN FE" },
  { "Explain String": "PLAN FRAGMENT 0" },
  { "Explain String": " OUTPUT EXPRS:2: expr" },
  { "Explain String": "  PARTITION: UNPARTITIONED" },
  { "Explain String": "" },
  { "Explain String": "  RESULT SINK" },
  { "Explain String": "" },
  { "Explain String": "  1:Project" },
  { "Explain String": "  |  <slot 2> : 1" },
  { "Explain String": "  |  " },
  { "Explain String": "  0:UNION" },
  { "Explain String": "     constant exprs: " },
  { "Explain String": "         NULL" },
];

function rootOf(model: unknown): ExplainTreeNode {
  return (model as { root: ExplainTreeNode }).root;
}

describe("mysqlTextStrategy", () => {
  test("format id", () => {
    expect(mysqlTextStrategy.format).toBe("mysql-text");
  });

  test("buildSql prefixes SELECT and WITH identically in both modes", () => {
    expect(mysqlTextStrategy.buildSql("SELECT 1", "estimate")).toBe("EXPLAIN SELECT 1");
    expect(mysqlTextStrategy.buildSql("SELECT 1", "analyze")).toBe("EXPLAIN SELECT 1");
    expect(mysqlTextStrategy.buildSql("WITH t AS (SELECT 1) SELECT * FROM t", "estimate")).toBe(
      "EXPLAIN WITH t AS (SELECT 1) SELECT * FROM t",
    );
    expect(mysqlTextStrategy.buildSql("-- a comment\nSELECT 1", "estimate")).toBe("EXPLAIN -- a comment\nSELECT 1");
  });

  test("buildSql returns null for a non-SELECT and for a comment on its own", () => {
    expect(mysqlTextStrategy.buildSql("SHOW STATUS", "estimate")).toBeNull();
    expect(mysqlTextStrategy.buildSql("UPDATE t SET a = 1", "analyze")).toBeNull();
    expect(mysqlTextStrategy.buildSql("-- nothing here", "estimate")).toBeNull();
  });

  test("extractPlan stores the rows verbatim and an empty array when there are none", () => {
    expect(mysqlTextStrategy.extractPlan({ rows: STARROCKS_SELECT1_ROWS })).toEqual(STARROCKS_SELECT1_ROWS);
    expect(mysqlTextStrategy.extractPlan({})).toEqual([]);
  });

  test("toRenderModel rejects foreign shapes", () => {
    expect(mysqlTextStrategy.toRenderModel(null)).toBeNull();
    expect(mysqlTextStrategy.toRenderModel("EXPLAIN")).toBeNull();
    expect(mysqlTextStrategy.toRenderModel([])).toBeNull();
    expect(mysqlTextStrategy.toRenderModel(["a line"])).toBeNull();
    expect(mysqlTextStrategy.toRenderModel([{}])).toBeNull();
  });

  test("TiDB join fixture nests by indentation and reads estRows", () => {
    const model = mysqlTextStrategy.toRenderModel(TIDB_JOIN_ROWS);
    expect(model?.kind).toBe("tree");
    const root = rootOf(model);
    expect(root.label).toBe("Sort_10");
    expect(root.metrics).toEqual({ estRows: 4162.5 });
    expect(root.detail).toBe("estRows: 4162.50, task: root, operator info: Column#6:desc");
    const hashJoin = root.children[0].children[0].children[0].children[0];
    expect(hashJoin.label).toBe("HashJoin_24");
    expect(hashJoin.children.map((child) => child.label)).toEqual(["TableReader_27(Build)", "TableReader_29(Probe)"]);
    expect(hashJoin.children[0].children[0].label).toBe("Selection_26");
    expect(hashJoin.children[1].children[0].label).toBe("TableFullScan_28");
  });

  test("TiDB raw text joins every column with two spaces, one line per row", () => {
    const model = mysqlTextStrategy.toRenderModel(TIDB_JOIN_ROWS);
    const lines = (model as { raw: string }).raw.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("Sort_10  4162.50  root    Column#6:desc");
  });

  test("StarRocks fixture drops blank rows and synthesises an EXPLAIN root", () => {
    const model = mysqlTextStrategy.toRenderModel(STARROCKS_SELECT1_ROWS);
    const root = rootOf(model);
    // Two lines sit at indent 0 (EXECUTE IN FE, PLAN FRAGMENT 0), so neither can be
    // the root of the other.
    expect(root.label).toBe("EXPLAIN");
    expect(root.children.map((child) => child.label)).toEqual(["EXECUTE IN FE", "PLAN FRAGMENT 0"]);
    expect(root.children[1].children[0].label).toBe("OUTPUT EXPRS:2: expr");
    const raw = (model as { raw: string }).raw;
    expect(raw.split("\n")).toHaveLength(11);
    expect(raw.split("\n")[0]).toBe("EXECUTE IN FE");
    expect(raw).not.toContain("\n\n");
    expect(root.children[0].metrics).toBeUndefined();
    expect(root.children[0].detail).toBeUndefined();
  });

  test("a non-numeric estRows column produces no metrics", () => {
    const model = mysqlTextStrategy.toRenderModel([{ id: "Sort_1", estRows: "n/a" }]);
    expect(rootOf(model).metrics).toBeUndefined();
    expect(rootOf(model).detail).toBe("estRows: n/a");
  });

  test("an empty or null estRows cell is an absent reading, never a fabricated 0", () => {
    // Number("") is 0 and Number.isFinite(0) is true, so a row whose estRows cell the
    // engine left blank used to render as "~0 rows": a figure nobody measured, which is
    // the class the absence rule (#477) exists to keep off the screen.
    expect(rootOf(mysqlTextStrategy.toRenderModel([{ id: "Sort_1", estRows: "" }])).metrics).toBeUndefined();
    expect(rootOf(mysqlTextStrategy.toRenderModel([{ id: "Sort_1", estRows: null }])).metrics).toBeUndefined();
    expect(rootOf(mysqlTextStrategy.toRenderModel([{ id: "Sort_1", estRows: "   " }])).metrics).toBeUndefined();
  });

  test("a null cell is neither detail nor a line break", () => {
    const model = mysqlTextStrategy.toRenderModel([
      { "Explain String(Nereids Planner)": "PLAN FRAGMENT 0", extra: null },
    ]);
    expect(rootOf(model).label).toBe("PLAN FRAGMENT 0");
    expect(rootOf(model).detail).toBeUndefined();
  });
});
