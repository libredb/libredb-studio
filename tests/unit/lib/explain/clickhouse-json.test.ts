import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";
import { clickhouseJsonStrategy } from "@/lib/explain/clickhouse-json";
import type { ExplainTreeNode } from "@/lib/explain/types";

// Captured verbatim from ClickHouse 26.7.1.1315 for
// `EXPLAIN json = 1, indexes = 1 SELECT id, email FROM users WHERE id > 1 ORDER BY email LIMIT 10`.
// The outer array with a single { Plan } member, the "Plans" child arrays and the
// "Indexes" array on ReadFromMergeTree are all exactly as the server emits them.
const LIVE_PLAN = [
  {
    Plan: {
      "Node Type": "Expression",
      "Node Id": "Expression_7",
      Description: "Project names",
      Plans: [
        {
          "Node Type": "Limit",
          "Node Id": "Limit_6",
          Description: "preliminary LIMIT",
          Plans: [
            {
              "Node Type": "Sorting",
              "Node Id": "Sorting_5",
              Description: "Sorting for ORDER BY",
              Plans: [
                {
                  "Node Type": "Expression",
                  "Node Id": "Expression_9",
                  Description: "(Before ORDER BY + Projection)",
                  Plans: [
                    {
                      "Node Type": "Expression",
                      "Node Id": "Expression_10",
                      Description: "(WHERE + Change column names to column identifiers)",
                      Plans: [
                        {
                          "Node Type": "ReadFromMergeTree",
                          "Node Id": "ReadFromMergeTree_0",
                          Description: "demo.users",
                          Indexes: [
                            {
                              Type: "PrimaryKey",
                              Keys: ["id"],
                              Condition: "(id in [2, +Inf))",
                              "Search Algorithm": "binary search",
                              "Initial Parts": 1,
                              "Selected Parts": 1,
                              "Initial Granules": 1,
                              "Selected Granules": 1,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
];

// Also live: `EXPLAIN json = 1, indexes = 1 SELECT count() FROM orders WHERE status = 'paid' GROUP BY user_id`.
// One ReadFromMergeTree carries four Indexes entries, and the data-skipping one adds
// "Name"/"Description" plus the only non-trivial pruning numbers in the payload.
const LIVE_INDEXES = [
  {
    Type: "Min-Max",
    Condition: "true",
    "Initial Parts": 3,
    "Selected Parts": 3,
    "Initial Granules": 3,
    "Selected Granules": 3,
  },
  {
    Type: "Partition",
    Condition: "true",
    "Initial Parts": 3,
    "Selected Parts": 3,
    "Initial Granules": 3,
    "Selected Granules": 3,
  },
  {
    Type: "PrimaryKey",
    Condition: "true",
    "Initial Parts": 3,
    "Selected Parts": 3,
    "Initial Granules": 3,
    "Selected Granules": 3,
  },
  {
    Type: "Skip",
    Name: "idx_status",
    Description: "set GRANULARITY 4",
    Condition: "(status in ['paid', 'paid'])",
    "Initial Parts": 3,
    "Selected Parts": 0,
    "Initial Granules": 3,
    "Selected Granules": 0,
  },
];

// Live shape for an INNER JOIN: "Plans" holds two children, and a node may omit "Description".
const LIVE_JOIN_PLAN = [
  {
    Plan: {
      "Node Type": "Expression",
      "Node Id": "Expression_20",
      Plans: [
        {
          "Node Type": "Join",
          "Node Id": "Join_18",
          Description: "JOIN FillRightFirst",
          Plans: [
            { "Node Type": "Expression", "Node Id": "Expression_16", Description: "Left Pre Join Actions" },
            { "Node Type": "Expression", "Node Id": "Expression_17", Description: "Right Pre Join Actions" },
          ],
        },
      ],
    },
  },
];

/** The wire shape: one row, one String column named "explain" whose value is the plan as JSON text. */
function explainResult(plan: unknown): { rows: Array<Record<string, unknown>> } {
  return { rows: [{ explain: JSON.stringify(plan) }] };
}

function treeRoot(raw: unknown): ExplainTreeNode {
  const model = clickhouseJsonStrategy.toRenderModel(raw);
  expect(model?.kind).toBe("tree");
  return (model as { root: ExplainTreeNode }).root;
}

/** Follows first children down from the root, collecting every label on the way. */
function spineLabels(root: ExplainTreeNode): string[] {
  const labels: string[] = [];
  for (let node: ExplainTreeNode | undefined = root; node !== undefined; node = node.children[0]) {
    labels.push(node.label);
  }
  return labels;
}

function readFromMergeTree(raw: unknown): ExplainTreeNode {
  const node = spineNode(treeRoot(raw), 5);
  expect(node.label).toBe("ReadFromMergeTree: demo.users");
  return node;
}

function spineNode(root: ExplainTreeNode, depth: number): ExplainTreeNode {
  let node = root;
  for (let step = 0; step < depth; step++) {
    node = node.children[0];
    expect(node).toBeDefined();
  }
  return node;
}

/** Builds a plan whose single ReadFromMergeTree node carries the given Indexes payload. */
function planWithIndexes(indexes: unknown): unknown {
  return [{ Plan: { "Node Type": "ReadFromMergeTree", Description: "demo.orders", Indexes: indexes } }];
}

describe("clickhouseJsonStrategy", () => {
  test("format id", () => {
    expect(clickhouseJsonStrategy.format).toBe("clickhouse-json");
  });

  test("is registered in the explain registry", () => {
    expect(getExplainStrategy("clickhouse-json")).toBe(clickhouseJsonStrategy);
  });

  // actions = 1 is deliberately absent: it inflated a two-table join plan roughly
  // tenfold on the live server and adds only expression internals the tree model
  // cannot render.
  test("buildSql asks for the JSON plan with index details and nothing else", () => {
    expect(clickhouseJsonStrategy.buildSql("SELECT id FROM users", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT id FROM users",
    );
    expect(clickhouseJsonStrategy.buildSql("  SELECT 1", "estimate")).toBe("EXPLAIN json = 1, indexes = 1   SELECT 1");
  });

  // ClickHouse EXPLAIN never executes the statement, so there is no analyze
  // equivalent to build. Returning null instead would kill the Explain button
  // outright: the direct action always builds with mode "analyze"
  // (use-query-execution.ts:165) and refuses the run when the strategy declines.
  // sqlite-queryplan.ts and couchbase-json.ts return the estimate for both modes
  // for the same reason.
  test("buildSql returns the estimate plan in analyze mode, matching the SQLite and Couchbase strategies", () => {
    expect(clickhouseJsonStrategy.buildSql("SELECT id FROM users", "analyze")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT id FROM users",
    );
  });

  // Live-verified: `EXPLAIN json = 1, indexes = 1 SELECT id FROM users FORMAT TSV`
  // answers with X-ClickHouse-Format: TSV and the plan as escaped TSV text, so the
  // tree can never be built. The FORMAT belongs to the statement's own result, not to
  // the plan, so it is dropped rather than honoured.
  test("buildSql drops a trailing FORMAT clause, which would otherwise reformat the plan itself", () => {
    expect(clickhouseJsonStrategy.buildSql("SELECT id FROM users FORMAT TSV", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT id FROM users",
    );
    expect(clickhouseJsonStrategy.buildSql("SELECT id FROM users format JSONEachRow  ", "analyze")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT id FROM users",
    );
  });

  // prepareQuery already treats both of these as carrying a trailing FORMAT (its own
  // tests cover "a trailing FORMAT clause and a semicolon" and "FORMAT followed by
  // SETTINGS"), so the explain builder has to recognise the same shapes or the plan
  // comes back as TSV and no tree can be built.
  test("buildSql drops a trailing FORMAT that is followed by a semicolon", () => {
    expect(clickhouseJsonStrategy.buildSql("SELECT id FROM users FORMAT TSV;", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT id FROM users;",
    );
  });

  // The SETTINGS clause is kept: it applies to the inner statement and is
  // semantically meaningful (max_execution_time and friends). Only FORMAT changes
  // the shape of the EXPLAIN output itself.
  test("buildSql drops a trailing FORMAT but keeps a SETTINGS clause after it", () => {
    expect(
      clickhouseJsonStrategy.buildSql("SELECT id FROM users FORMAT TSV SETTINGS max_threads = 1", "estimate"),
    ).toBe("EXPLAIN json = 1, indexes = 1 SELECT id FROM users SETTINGS max_threads = 1");
  });

  test("buildSql drops a trailing FORMAT before SETTINGS and a semicolon together", () => {
    expect(
      clickhouseJsonStrategy.buildSql("SELECT id FROM users FORMAT JSONEachRow SETTINGS max_threads=2;", "analyze"),
    ).toBe("EXPLAIN json = 1, indexes = 1 SELECT id FROM users SETTINGS max_threads=2;");
  });

  test("buildSql keeps a statement whose FORMAT is not a trailing clause intact", () => {
    expect(clickhouseJsonStrategy.buildSql("SELECT formatDateTime(d, '%Y') FROM t", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT formatDateTime(d, '%Y') FROM t",
    );
    expect(clickhouseJsonStrategy.buildSql("SELECT id FROM t WHERE note = 'FORMAT TSV'", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 SELECT id FROM t WHERE note = 'FORMAT TSV'",
    );
  });

  // Block comments nest in ClickHouse too (#300), so this strategy reads the statement
  // under ClickHouse's grammar. Nothing here executes - ClickHouse's EXPLAIN describes
  // without running, unlike PostgreSQL's ANALYZE - so what this buys is an honest
  // classification rather than a write prevented: a statement whose real keyword is a
  // write no longer gets an Explain built for it, and a read hidden behind a nested
  // comment does.
  test("buildSql reads a nested comment the way ClickHouse does", () => {
    expect(
      clickhouseJsonStrategy.buildSql("/* a /* b */ SELECT 1 */ ALTER TABLE users DELETE WHERE id = 1", "estimate"),
    ).toBeNull();

    const read = "/* a /* b */ x */ SELECT 1";
    expect(clickhouseJsonStrategy.buildSql(read, "estimate")).toBe(`EXPLAIN json = 1, indexes = 1 ${read}`);
  });

  test("buildSql returns null for non-SELECT statements in both modes", () => {
    expect(clickhouseJsonStrategy.buildSql("INSERT INTO users FORMAT Values (1)", "estimate")).toBeNull();
    expect(
      clickhouseJsonStrategy.buildSql("ALTER TABLE users UPDATE country = 'TR' WHERE id = 1", "estimate"),
    ).toBeNull();
    expect(clickhouseJsonStrategy.buildSql("EXPLAIN json = 1 SELECT 1", "estimate")).toBeNull();
    expect(clickhouseJsonStrategy.buildSql("OPTIMIZE TABLE users FINAL", "analyze")).toBeNull();
  });

  // The single cell is a String whose value is JSON, so the envelope parse leaves a
  // string behind and a second parse is mandatory. Storing the parsed array keeps the
  // raw JSON tab and the AI tab readable instead of showing one escaped blob.
  test("extractPlan parses the JSON string carried by the single explain cell", () => {
    expect(clickhouseJsonStrategy.extractPlan(explainResult(LIVE_PLAN))).toEqual(LIVE_PLAN);
  });

  test("extractPlan keeps the cell text when the inner JSON cannot be parsed", () => {
    expect(clickhouseJsonStrategy.extractPlan({ rows: [{ explain: "[{ oops" }] })).toBe("[{ oops");
    expect(clickhouseJsonStrategy.extractPlan({ rows: [{ explain: "" }] })).toBe("");
  });

  test("extractPlan falls back to the raw rows when there is no explain cell", () => {
    const rows = [{ nope: 1 }];
    expect(clickhouseJsonStrategy.extractPlan({ rows })).toEqual(rows);
    expect(clickhouseJsonStrategy.extractPlan({ rows: [] })).toEqual([]);
    expect(clickhouseJsonStrategy.extractPlan({})).toBeUndefined();
  });

  test("toRenderModel walks the nested Plans arrays down to the table read", () => {
    const model = clickhouseJsonStrategy.toRenderModel(LIVE_PLAN);
    expect(model).toEqual({ kind: "tree", root: expect.anything(), raw: LIVE_PLAN });
    expect(spineLabels((model as { root: ExplainTreeNode }).root)).toEqual([
      "Expression: Project names",
      "Limit: preliminary LIMIT",
      "Sorting: Sorting for ORDER BY",
      "Expression: (Before ORDER BY + Projection)",
      "Expression: (WHERE + Change column names to column identifiers)",
      "ReadFromMergeTree: demo.users",
      "Index PrimaryKey (id): parts 1/1, granules 1/1",
    ]);
  });

  test("toRenderModel renders end to end from what extractPlan stored", () => {
    const root = treeRoot(clickhouseJsonStrategy.extractPlan(explainResult(LIVE_PLAN)));
    expect(root.label).toBe("Expression: Project names");
  });

  // A plan stored before extractPlan parsed it - or read back from an older tab -
  // is still the unparsed cell text, so the render boundary parses too.
  test("toRenderModel accepts the unparsed cell text as well as the parsed array", () => {
    expect(treeRoot(JSON.stringify(LIVE_PLAN)).label).toBe("Expression: Project names");
  });

  test("toRenderModel surfaces every Indexes entry as a child of the read node", () => {
    const children = treeRoot(planWithIndexes(LIVE_INDEXES)).children;
    expect(children.map((child) => child.label)).toEqual([
      "Index Min-Max: parts 3/3, granules 3/3",
      "Index Partition: parts 3/3, granules 3/3",
      "Index PrimaryKey: parts 3/3, granules 3/3",
      "Index Skip idx_status: parts 0/3, granules 0/3",
    ]);
    expect(children[3].detail).toBe("condition: (status in ['paid', 'paid']) | definition: set GRANULARITY 4");
    expect(children[3].children).toEqual([]);
  });

  test("toRenderModel puts the index condition and search algorithm in detail", () => {
    expect(readFromMergeTree(LIVE_PLAN).children[0].detail).toBe(
      "condition: (id in [2, +Inf)) | search: binary search",
    );
  });

  test("toRenderModel keeps plan children ahead of index children", () => {
    const root = treeRoot([
      {
        Plan: {
          "Node Type": "ReadFromMergeTree",
          Plans: [{ "Node Type": "ReadFromSystemNumbers" }],
          Indexes: [{ Type: "PrimaryKey" }],
        },
      },
    ]);
    expect(root.children.map((child) => child.label)).toEqual(["ReadFromSystemNumbers", "Index PrimaryKey"]);
  });

  test("toRenderModel degrades an index entry that omits type, keys or counts", () => {
    const children = treeRoot(
      planWithIndexes([
        {},
        { Type: "Skip", Keys: ["status", 7, ""], "Selected Parts": 1 },
        { Type: "MinMax", "Selected Granules": 0, "Initial Granules": 4, "Initial Parts": "3" },
      ]),
    ).children;
    expect(children.map((child) => child.label)).toEqual([
      "Index",
      "Index Skip (status)",
      "Index MinMax: granules 0/4",
    ]);
    expect(children.map((child) => child.detail)).toEqual([undefined, undefined, undefined]);
  });

  test("toRenderModel treats a node without Plans as a leaf", () => {
    const root = treeRoot([{ Plan: { "Node Type": "ReadFromStorage", Description: "SystemOne" } }]);
    expect(root).toEqual({ label: "ReadFromStorage: SystemOne", children: [] });
  });

  test("toRenderModel ignores Plans and Indexes values that are not the expected shape", () => {
    expect(treeRoot([{ Plan: { "Node Type": "Union", Plans: "none", Indexes: "none" } }]).children).toEqual([]);
    expect(
      treeRoot([{ Plan: { "Node Type": "Union", Plans: [{ nope: 1 }, { "Node Type": "Limit" }], Indexes: [7] } }])
        .children,
    ).toEqual([{ label: "Limit", children: [] }]);
  });

  test("toRenderModel omits the description suffix when the node has none", () => {
    const root = treeRoot(LIVE_JOIN_PLAN);
    expect(root.label).toBe("Expression");
    expect(root.children[0].label).toBe("Join: JOIN FillRightFirst");
    expect(root.children[0].children.map((child) => child.label)).toEqual([
      "Expression: Left Pre Join Actions",
      "Expression: Right Pre Join Actions",
    ]);
    expect(treeRoot([{ Plan: { "Node Type": "Limit", Description: "" } }]).label).toBe("Limit");
  });

  test("toRenderModel accepts the plan node at every wrapper depth the server or storage may present", () => {
    const node = { "Node Type": "Limit" };
    expect(treeRoot(node).label).toBe("Limit");
    expect(treeRoot({ Plan: node }).label).toBe("Limit");
    expect(treeRoot([{ Plan: node }]).label).toBe("Limit");
  });

  test("toRenderModel rejects shapes that are not ClickHouse plans", () => {
    expect(clickhouseJsonStrategy.toRenderModel(null)).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel(undefined)).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel(7)).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel([])).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel({})).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel([{ Plan: {} }])).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel({ "Node Type": 7 })).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel([{ id: 3, parent: 0, detail: "SCAN users" }])).toBeNull();
  });

  test("toRenderModel rejects cell text that is not JSON", () => {
    expect(clickhouseJsonStrategy.toRenderModel("[{ oops")).toBeNull();
    expect(clickhouseJsonStrategy.toRenderModel("")).toBeNull();
    // Unwrapping is depth-bounded so a pathological wrapper chain cannot loop.
    expect(
      clickhouseJsonStrategy.toRenderModel([{ Plan: [{ Plan: [{ Plan: { "Node Type": "Limit" } }] }] }]),
    ).toBeNull();
  });

  // Both live-verified accepted through this exact prefix, and ClickHouse's EXPLAIN describes without running,
  // so a CTE is safe to explain here - no write can hide inside one.
  test("buildSql explains a CTE and a commented SELECT", () => {
    const cte = "WITH t AS (SELECT 1 AS x) SELECT * FROM t";
    expect(clickhouseJsonStrategy.buildSql(cte, "analyze")).toBe(`EXPLAIN json = 1, indexes = 1 ${cte}`);
    expect(clickhouseJsonStrategy.buildSql("-- note\nSELECT 1", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 -- note\nSELECT 1",
    );
    expect(clickhouseJsonStrategy.buildSql("/* note */ SELECT 1", "estimate")).toBe(
      "EXPLAIN json = 1, indexes = 1 /* note */ SELECT 1",
    );
  });

  test("buildSql still declines a comment with no statement behind it", () => {
    expect(clickhouseJsonStrategy.buildSql("-- only a comment", "analyze")).toBeNull();
    expect(clickhouseJsonStrategy.buildSql("/* only a comment */", "analyze")).toBeNull();
  });
});
