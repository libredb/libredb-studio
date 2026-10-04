import { describe, test, expect } from "bun:test";
import { mysqlJsonStrategy } from "@/lib/explain/mysql-json";
import type { ExplainTreeNode } from "@/lib/explain/types";

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

  test("extractPlan keeps the rows: the plan is read from them when drawn", () => {
    const rows = [{ EXPLAIN: '{"query_block":{}}' }];
    expect(mysqlJsonStrategy.extractPlan({ rows })).toEqual(rows);
    expect(mysqlJsonStrategy.extractPlan({})).toEqual([]);
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

/**
 * The plans below are what the servers answered on 2026-10-04 for
 * `SELECT c.city, SUM(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id
 * WHERE c.city = 'x' GROUP BY c.city`, trimmed of keys these tests do not read (#1389).
 * Until then every one of them drew an empty plan under "Query looks good".
 */
describe("mysqlJsonStrategy.toRenderModel (#1389)", () => {
  type Node = ExplainTreeNode;
  const tree = (rows: unknown): Node => {
    const model = mysqlJsonStrategy.toRenderModel(rows);
    if (model?.kind !== "tree") throw new Error(`expected a tree, got ${JSON.stringify(model)}`);
    return model.root;
  };
  const labels = (node: Node): string[] => [node.label, ...node.children.flatMap(labels)];

  // MySQL 26.7.0 (`mysql:latest`), JSON format version 2.
  const FORMAT_2 = {
    query: "/* select#1 */ select ...",
    query_plan: {
      inputs: [
        {
          inputs: [
            {
              inputs: [
                {
                  alias: "c",
                  operation: "Table scan on c",
                  table_name: "customers",
                  access_type: "table",
                  used_columns: ["id", "city"],
                  estimated_rows: 3.0,
                  estimated_total_cost: 0.55,
                },
              ],
              condition: "(c.city = 'x')",
              operation: "Filter: (c.city = 'x')",
              access_type: "filter",
              estimated_rows: 1.0000000298023224,
              estimated_total_cost: 0.55,
            },
            {
              alias: "o",
              operation: "Index lookup on o using idx_c (customer_id = c.id)",
              index_name: "idx_c",
              table_name: "orders",
              access_type: "index",
              estimated_rows: 1.3333333730697632,
              estimated_total_cost: 0.4666666766007741,
            },
          ],
          join_type: "inner join",
          operation: "Nested loop inner join",
          access_type: "join",
          estimated_rows: 1.3333334128061942,
          estimated_total_cost: 1.016666694482168,
        },
      ],
      group_by: true,
      functions: ["sum(o.amount)"],
      operation: "Group aggregate: sum(o.amount)",
      access_type: "aggregate",
      estimated_rows: 1.0,
      estimated_total_cost: 1.323886374852259,
    },
    query_type: "select",
    json_schema_version: "2.0",
  };

  test("MySQL 26.7 format 2: the operations nest by their inputs, with estimates", () => {
    const root = tree([{ EXPLAIN: JSON.stringify(FORMAT_2) }]);

    expect(labels(root)).toEqual([
      "Group aggregate: sum(o.amount)",
      "Nested loop inner join",
      "Filter: (c.city = 'x')",
      "Table scan on c",
      "Index lookup on o using idx_c (customer_id = c.id)",
    ]);
    expect(root.metrics).toEqual({ estRows: 1, estCost: 1.323886374852259 });
    const lookup = root.children[0].children[1];
    expect(lookup.metrics?.estRows).toBeCloseTo(1.333, 3);
    expect(lookup.detail).toContain("index_name: idx_c");
    // The operation names the alias, so the table it reads stays in the detail.
    expect(lookup.detail).toContain("table_name: orders");
    expect(root.children[0].children[0].children[0].detail).toContain("used_columns: id, city");
    // The statement text is not plan detail.
    expect(root.detail).not.toContain("select#1");
  });

  test("a cell the driver already parsed reads the same as its JSON text", () => {
    expect(tree([{ EXPLAIN: FORMAT_2 }])).toEqual(tree([{ EXPLAIN: JSON.stringify(FORMAT_2) }]));
  });

  test("classic MySQL query_block: tables by name, figures from cost_info", () => {
    const classic = {
      query_block: {
        select_id: 1,
        cost_info: { query_cost: "1.02" },
        grouping_operation: {
          using_filesort: false,
          nested_loop: [
            {
              table: {
                table_name: "c",
                access_type: "ALL",
                rows_examined_per_scan: 3,
                filtered: "33.33",
                cost_info: { read_cost: "0.45", prefix_cost: "0.55" },
              },
            },
            {
              table: {
                table_name: "o",
                access_type: "ref",
                key: "idx_c",
                rows_examined_per_scan: 1,
                cost_info: { prefix_cost: "1.02" },
              },
            },
          ],
        },
      },
    };
    const root = tree([{ EXPLAIN: JSON.stringify(classic) }]);

    expect(labels(root)).toEqual(["query block #1", "grouping operation", "table c", "table o"]);
    expect(root.metrics).toEqual({ estCost: 1.02 });
    const scan = root.children[0].children[0];
    expect(scan.metrics).toEqual({ estRows: 3, estCost: 0.55 });
    expect(scan.detail).toContain("access_type: ALL");
    // The label already says the table and the select number.
    expect(scan.detail).not.toContain("table_name");
    expect(root.detail).toBeUndefined();
    expect(root.children[0].detail).toBe("using_filesort: false");
  });

  test("MariaDB 13.0.2 query_block: rows and cost, wrappers nested", () => {
    const mariadb = {
      query_block: {
        select_id: 1,
        cost: 0.020341354,
        nested_loop: [
          {
            read_sorted_file: {
              filesort: {
                sort_key: "customers.`name`",
                table: { table_name: "customers", access_type: "ALL", rows: 3, cost: 0.0113438, filtered: 100 },
              },
            },
          },
          { table: { table_name: "orders", access_type: "ref", key: "idx_c", rows: 1, cost: 0.00709888 } },
        ],
      },
    };
    const root = tree([{ EXPLAIN: JSON.stringify(mariadb) }]);

    expect(labels(root)).toEqual(["query block #1", "read sorted file", "filesort", "table customers", "table orders"]);
    expect(root.children[0].children[0].children[0].metrics).toEqual({ estRows: 3, estCost: 0.0113438 });
  });

  test("OceanBase's text plan is shown as text, one line per node", () => {
    const text = "=====\n|ID|OPERATOR   |NAME|\n-----\n|0 |HASH JOIN  |    |\n=====";
    const model = mysqlJsonStrategy.toRenderModel([{ "Query Plan": text }]);

    expect(model?.kind).toBe("tree");
    if (model?.kind !== "tree") return;
    expect(model.raw).toBe(text);
    expect(labels(model.root)).toContain("|0 |HASH JOIN  |    |");
  });

  test("a JSON document of an unknown shape is shown as text, never as an empty plan", () => {
    const model = mysqlJsonStrategy.toRenderModel([{ EXPLAIN: '{"steps":[]}' }]);
    expect(model?.kind).toBe("tree");
    if (model?.kind !== "tree") return;
    expect(model.raw).toBe('{"steps":[]}');
  });

  test("nothing to read is no plan", () => {
    expect(mysqlJsonStrategy.toRenderModel([])).toBeNull();
    expect(mysqlJsonStrategy.toRenderModel(null)).toBeNull();
    expect(mysqlJsonStrategy.toRenderModel([{ EXPLAIN: 7 }, "x"])).toBeNull();
    expect(mysqlJsonStrategy.toRenderModel([{ EXPLAIN: null }])).toBeNull();
  });

  test("a figure that is blank, non-numeric or infinite is no figure", () => {
    const root = tree([
      {
        EXPLAIN: {
          query_block: { select_id: 1, cost_info: { query_cost: "" }, rows: "many", cost: Number.POSITIVE_INFINITY },
        },
      },
    ]);
    expect(root.metrics).toBeUndefined();
  });

  test("a plan nested past any optimizer's depth is cut, visibly", () => {
    let plan: Record<string, unknown> = { operation: "leaf" };
    for (let i = 0; i < 100; i++) plan = { operation: `level ${i}`, inputs: [plan] };
    let node = tree([{ EXPLAIN: { query_plan: plan } }]);
    while (node.children.length > 0) node = node.children[0];
    expect(node.label).toBe("plan truncated: nesting limit reached");
  });

  test("an array of objects that are not single-key wrappers is one child per element", () => {
    const root = tree([
      {
        EXPLAIN: {
          query_block: {
            select_id: 1,
            attached_subqueries: [{ dependent: true, query_block: { select_id: 2 } }],
          },
        },
      },
    ]);
    expect(labels(root)).toEqual(["query block #1", "attached subqueries", "query block #2"]);
    expect(root.children[0].detail).toBe("dependent: true");
  });
});
