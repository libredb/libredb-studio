import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";
import { druidNativeStrategy } from "@/lib/explain/druid-native";
import type { ExplainTreeNode } from "@/lib/explain/types";

/**
 * Druid stamps every plan with the same all-of-time interval; it is noise in a
 * fixture but it is what the server emits, so it stays.
 */
const ETERNITY = "-146136543-09-08T08:23:32.096Z/146140482-04-24T15:36:27.903Z";
const INTERVALS = { type: "intervals", intervals: [ETERNITY] };

/**
 * Captured from Apache Druid 37.0.0 for
 * `EXPLAIN PLAN FOR SELECT a.region, COUNT(*) AS c FROM libredb_demo a
 *   INNER JOIN (SELECT region, MAX(qty) AS mq FROM libredb_rollup GROUP BY region) b
 *   ON a.region = b.region WHERE a.qty > 5 GROUP BY a.region`.
 *
 * This is the shape that settled the render model: a table under a join under a
 * groupBy, with the right leg wrapped in a `query` dataSource. The recursion
 * through `dataSource` is the operator tree. Only the per-request `context`
 * ({queryId, sqlQueryId}) is dropped - it is a fresh UUID on every call and
 * describes the request, not the plan.
 */
const LIVE_JOIN_PLAN = [
  {
    query: {
      queryType: "groupBy",
      dataSource: {
        type: "join",
        left: { type: "table", name: "libredb_demo" },
        right: {
          type: "query",
          query: {
            queryType: "groupBy",
            dataSource: { type: "table", name: "libredb_rollup" },
            intervals: INTERVALS,
            granularity: { type: "all" },
            dimensions: [{ type: "default", dimension: "region", outputName: "d0", outputType: "STRING" }],
            limitSpec: { type: "NoopLimitSpec" },
          },
        },
        rightPrefix: "j0.",
        condition: '("region" == "j0.d0")',
        joinType: "INNER",
      },
      intervals: INTERVALS,
      filter: { type: "range", column: "qty", matchValueType: "LONG", lower: 5, lowerOpen: true },
      granularity: { type: "all" },
      dimensions: [{ type: "default", dimension: "region", outputName: "d0", outputType: "STRING" }],
      aggregations: [{ type: "count", name: "a0" }],
      limitSpec: { type: "NoopLimitSpec" },
    },
    signature: [
      { name: "d0", type: "STRING" },
      { name: "a0", type: "LONG" },
    ],
    columnMappings: [
      { queryColumn: "d0", outputColumn: "region" },
      { queryColumn: "a0", outputColumn: "c" },
    ],
  },
];

/** Live for the same query: RESOURCES lists what the statement reads. */
const LIVE_RESOURCES = [
  { name: "libredb_demo", type: "DATASOURCE" },
  { name: "libredb_rollup", type: "DATASOURCE" },
];

/** Live: ATTRIBUTES is an object, not an array. */
const LIVE_ATTRIBUTES = { statementType: "SELECT" };

/**
 * Live for `EXPLAIN PLAN FOR SELECT * FROM libredb_demo LIMIT 5` - the simplest
 * single-query plan there is: a scan straight off a table, no filter and no
 * aggregation. `columns`/`columnTypes` are trimmed for length; nothing the tree
 * reads is affected.
 */
const LIVE_SCAN_PLAN = [
  {
    query: {
      queryType: "scan",
      dataSource: { type: "table", name: "libredb_demo" },
      intervals: INTERVALS,
      resultFormat: "compactedList",
      limit: 5,
      columns: ["__time", "id", "region"],
      columnTypes: ["LONG", "LONG", "STRING"],
      granularity: { type: "all" },
      legacy: false,
    },
    signature: [{ name: "id", type: "LONG" }],
    columnMappings: [{ queryColumn: "id", outputColumn: "id" }],
  },
];

/**
 * Live for `EXPLAIN PLAN FOR SELECT COUNT(*) AS n FROM (SELECT region FROM libredb_demo GROUP BY region)`.
 * The subquery becomes a `query` dataSource, and the outer groupBy reports
 * `dimensions: []` - an empty array, which must not produce an empty row.
 */
const LIVE_SUBQUERY_PLAN = [
  {
    query: {
      queryType: "groupBy",
      dataSource: {
        type: "query",
        query: {
          queryType: "groupBy",
          dataSource: { type: "table", name: "libredb_demo" },
          intervals: INTERVALS,
          granularity: { type: "all" },
          dimensions: [{ type: "default", dimension: "region", outputName: "d0", outputType: "STRING" }],
          limitSpec: { type: "NoopLimitSpec" },
        },
      },
      intervals: INTERVALS,
      granularity: { type: "all" },
      dimensions: [],
      aggregations: [{ type: "count", name: "a0" }],
      limitSpec: { type: "NoopLimitSpec" },
    },
  },
];

/** Live for `... SELECT region FROM libredb_demo UNION ALL SELECT region FROM libredb_rollup`. */
const LIVE_UNION_PLAN = [
  {
    query: {
      queryType: "scan",
      dataSource: {
        type: "union",
        dataSources: [
          { type: "table", name: "libredb_demo" },
          { type: "table", name: "libredb_rollup" },
        ],
      },
      intervals: INTERVALS,
      granularity: { type: "all" },
    },
  },
];

/**
 * Live for `... SELECT region, COUNT(*) AS c FROM libredb_demo GROUP BY region ORDER BY 2 DESC LIMIT 3`.
 * topN names its single grouping key `dimension` (singular), so the dimensions
 * row has to accept both spellings.
 */
const LIVE_TOPN_PLAN = [
  {
    query: {
      queryType: "topN",
      dataSource: { type: "table", name: "libredb_demo" },
      dimension: { type: "default", dimension: "region", outputName: "d0", outputType: "STRING" },
      metric: { type: "numeric", metric: "a0" },
      threshold: 3,
      granularity: { type: "all" },
      aggregations: [{ type: "count", name: "a0" }],
    },
  },
];

/**
 * Live for `... SELECT TIME_FLOOR(__time, 'P1D') AS d, COUNT(*) AS c FROM libredb_demo GROUP BY 1`.
 * Two shapes only this plan reveals: `granularity` is a bare string ("DAY", and
 * "SIX_HOUR" for PT6H) rather than the usual {type:"all"} object, and
 * `dimensions` is explicit null.
 */
const LIVE_TIMESERIES_PLAN = [
  {
    query: {
      queryType: "timeseries",
      dataSource: { type: "table", name: "libredb_demo" },
      intervals: INTERVALS,
      granularity: "DAY",
      dimensions: null,
      virtualColumns: null,
      aggregations: [{ type: "count", name: "a0" }],
    },
  },
];

/**
 * Live for
 * `... SELECT region, SUM(qty) AS s FROM libredb_demo GROUP BY region
 *  UNION ALL SELECT name, COUNT(*) FROM libredb_rollup GROUP BY name`.
 *
 * PLAN is an array and it is NOT always length 1: two aggregating branches of a
 * UNION ALL come back as two independent native queries. Rendering only the first
 * would silently hide half the plan.
 */
const LIVE_TWO_QUERY_PLAN = [
  {
    query: {
      queryType: "groupBy",
      dataSource: { type: "table", name: "libredb_demo" },
      granularity: { type: "all" },
      dimensions: [{ type: "default", dimension: "region", outputName: "d0", outputType: "STRING" }],
      aggregations: [{ type: "longSum", name: "a0", fieldName: "qty" }],
    },
  },
  {
    query: {
      queryType: "groupBy",
      dataSource: { type: "table", name: "libredb_rollup" },
      granularity: { type: "all" },
      dimensions: [{ type: "default", dimension: "name", outputName: "d0", outputType: "STRING" }],
      aggregations: [{ type: "count", name: "a0" }],
    },
  },
];

/** Live for `... SELECT * FROM (VALUES (1),(2)) AS t(x)` - the only inline dataSource SQL can produce. */
const LIVE_INLINE_PLAN = [
  {
    query: {
      queryType: "scan",
      dataSource: { type: "inline", columnNames: ["x"], columnTypes: ["LONG"], rows: [[1], [2]] },
      intervals: INTERVALS,
      granularity: { type: "all" },
    },
  },
];

/** The wire shape: one row, three columns, each holding JSON text. */
function explainResult(
  plan: unknown,
  resources: unknown = LIVE_RESOURCES,
  attributes: unknown = LIVE_ATTRIBUTES,
): { rows: Array<Record<string, unknown>> } {
  return {
    rows: [
      { PLAN: JSON.stringify(plan), RESOURCES: JSON.stringify(resources), ATTRIBUTES: JSON.stringify(attributes) },
    ],
  };
}

/** What extractPlan stores, without going through JSON text. */
function stored(plan: unknown): unknown {
  return { plan, resources: LIVE_RESOURCES, attributes: LIVE_ATTRIBUTES };
}

function treeRoot(raw: unknown): ExplainTreeNode {
  const model = druidNativeStrategy.toRenderModel(raw);
  expect(model?.kind).toBe("tree");
  return (model as { root: ExplainTreeNode }).root;
}

/** Builds a one-entry plan around a single native query. */
function planOf(query: unknown): unknown {
  return [{ query }];
}

/** Builds a one-entry plan whose root scan reads the given dataSource. */
function planWithDataSource(dataSource: unknown): unknown {
  return planOf({ queryType: "scan", dataSource });
}

function labels(nodes: ExplainTreeNode[]): string[] {
  return nodes.map((node) => node.label);
}

/** Follows first children down from the root, collecting every label on the way. */
function spineLabels(root: ExplainTreeNode): string[] {
  const collected: string[] = [];
  for (let node: ExplainTreeNode | undefined = root; node !== undefined; node = node.children[0]) {
    collected.push(node.label);
  }
  return collected;
}

/** The dataSource node of a plan built by planWithDataSource. */
function dataSourceNode(dataSource: unknown): ExplainTreeNode {
  return treeRoot(planWithDataSource(dataSource)).children[0];
}

/** A `query` dataSource chain `levels` deep, to exercise the recursion bound. */
function nestedQueryChain(levels: number): unknown {
  let dataSource: unknown = { type: "table", name: "libredb_demo" };
  for (let level = 0; level < levels; level++) {
    dataSource = { type: "query", query: { queryType: "groupBy", dataSource } };
  }
  return planWithDataSource(dataSource);
}

describe("druidNativeStrategy", () => {
  test("format id", () => {
    expect(druidNativeStrategy.format).toBe("druid-native");
  });

  test("is registered in the explain registry", () => {
    expect(getExplainStrategy("druid-native")).toBe(druidNativeStrategy);
  });

  test("buildSql wraps a SELECT in EXPLAIN PLAN FOR", () => {
    expect(druidNativeStrategy.buildSql("SELECT id FROM libredb_demo", "estimate")).toBe(
      "EXPLAIN PLAN FOR SELECT id FROM libredb_demo",
    );
    expect(druidNativeStrategy.buildSql("  select 1", "estimate")).toBe("EXPLAIN PLAN FOR   select 1");
  });

  // Druid's EXPLAIN never executes the statement, so analyze has no separate form
  // to build. Returning null for it would kill the Explain button outright: the
  // direct action always builds with mode "analyze" (use-query-execution.ts:165)
  // and refuses the run when the strategy declines. sqlite-queryplan.ts and
  // couchbase-json.ts return the estimate for both modes for the same reason.
  test("buildSql returns the same plan in analyze mode, matching the SQLite and Couchbase strategies", () => {
    expect(druidNativeStrategy.buildSql("SELECT id FROM libredb_demo", "analyze")).toBe(
      "EXPLAIN PLAN FOR SELECT id FROM libredb_demo",
    );
  });

  // Live-verified: `EXPLAIN PLAN FOR SELECT 1 AS c1;` is accepted, so the
  // semicolon needs no special handling and must not be stripped.
  test("buildSql leaves a trailing semicolon in place, which Druid accepts", () => {
    expect(druidNativeStrategy.buildSql("SELECT 1 AS c1;", "analyze")).toBe("EXPLAIN PLAN FOR SELECT 1 AS c1;");
  });

  // Live-verified accepted by Druid 37.0.0, and `analyzeQuery` already treats
  // `WITH ... SELECT` as a SELECT, so declining it here contradicted the pipeline and
  // left the Explain button dead on any CTE.
  test("buildSql accepts CTEs that lead to SELECT", () => {
    expect(druidNativeStrategy.buildSql("WITH t AS (SELECT 1) SELECT * FROM t", "estimate")).toBe(
      "EXPLAIN PLAN FOR WITH t AS (SELECT 1) SELECT * FROM t",
    );
  });

  test("buildSql accepts SELECT preceded by SQL comments", () => {
    expect(druidNativeStrategy.buildSql("-- note\nSELECT 1", "estimate")).toBe("EXPLAIN PLAN FOR -- note\nSELECT 1");
    expect(druidNativeStrategy.buildSql("/* multi\nline */ SELECT 1", "analyze")).toBe(
      "EXPLAIN PLAN FOR /* multi\nline */ SELECT 1",
    );
  });

  test("buildSql accepts comments and whitespace interleaved, and stacked ahead of a CTE", () => {
    expect(druidNativeStrategy.buildSql("/*a*//*b*/SELECT 1", "estimate")).toBe("EXPLAIN PLAN FOR /*a*//*b*/SELECT 1");
    expect(druidNativeStrategy.buildSql("--\nSELECT 1", "estimate")).toBe("EXPLAIN PLAN FOR --\nSELECT 1");
    const stacked = "-- a\n-- b\n  /* c */ WITH t AS (SELECT 1) SELECT * FROM t";
    expect(druidNativeStrategy.buildSql(stacked, "analyze")).toBe(`EXPLAIN PLAN FOR ${stacked}`);
  });

  // The near misses. Broadening the prefix must not turn it into "starts with
  // anything": a comment is not a statement, and the word boundary is what keeps
  // SELECTED and WITHER out.
  test("buildSql still declines comment-only input, empty input and words that merely start with the keywords", () => {
    expect(druidNativeStrategy.buildSql("-- only a comment", "estimate")).toBeNull();
    expect(druidNativeStrategy.buildSql("/* only a comment */", "analyze")).toBeNull();
    expect(druidNativeStrategy.buildSql("", "estimate")).toBeNull();
    expect(druidNativeStrategy.buildSql("   ", "analyze")).toBeNull();
    expect(druidNativeStrategy.buildSql("SELECTED 1", "estimate")).toBeNull();
    expect(druidNativeStrategy.buildSql("WITHER", "analyze")).toBeNull();
    // An unterminated block comment never closes, so nothing after it is reached.
    expect(druidNativeStrategy.buildSql("/* unterminated SELECT 1", "estimate")).toBeNull();
  });

  // The prefix check now lives in `select-prefix.ts`, shared by all six strategies, and
  // so does its backtracking guard - the ReDoS property belongs to the regex, not to
  // this dialect. What stays here is that Druid ROUTES through it: a statement it
  // cannot explain still declines, cheaply.
  test("buildSql declines a long comment run that never reaches a SELECT, without backtracking", () => {
    const started = performance.now();

    expect(druidNativeStrategy.buildSql(`${"--".repeat(2000)}UPDATE t SET a = 1`, "analyze")).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  // Druid rejects UPDATE and DELETE outright and routes INSERT/REPLACE to the MSQ
  // task engine, so none of them is explainable through this endpoint.
  test("buildSql returns null for non-SELECT statements in both modes", () => {
    expect(druidNativeStrategy.buildSql("INSERT INTO t SELECT 1", "estimate")).toBeNull();
    expect(druidNativeStrategy.buildSql("REPLACE INTO t OVERWRITE ALL SELECT 1", "analyze")).toBeNull();
    expect(druidNativeStrategy.buildSql("UPDATE t SET a = 1", "estimate")).toBeNull();
    expect(druidNativeStrategy.buildSql("DELETE FROM t WHERE a = 1", "analyze")).toBeNull();
    expect(druidNativeStrategy.buildSql("EXPLAIN PLAN FOR SELECT 1", "estimate")).toBeNull();
  });

  // All three columns arrive as JSON text, so the envelope parse leaves three
  // escaped blobs behind. Parsing them here is what gives the raw JSON tab and the
  // AI tab a structure to read instead of one long escaped string.
  test("extractPlan parses all three JSON-string columns into one structure", () => {
    expect(druidNativeStrategy.extractPlan(explainResult(LIVE_JOIN_PLAN))).toEqual({
      plan: LIVE_JOIN_PLAN,
      resources: LIVE_RESOURCES,
      attributes: LIVE_ATTRIBUTES,
    });
  });

  // Live: a statement reading no datasource (SELECT 1) reports RESOURCES "[]".
  test("extractPlan keeps an empty RESOURCES array", () => {
    const extracted = druidNativeStrategy.extractPlan(explainResult(LIVE_SCAN_PLAN, [], { statementType: "SELECT" }));
    expect(extracted).toEqual({ plan: LIVE_SCAN_PLAN, resources: [], attributes: { statementType: "SELECT" } });
  });

  // Regression guard. The plan columns are JSON TEXT inside an already-parsed body,
  // so the transport's pass over the outer body correctly leaves their digits alone -
  // relative to that body they sit inside a string literal. This is a SECOND,
  // independent parse and therefore a second chance to round the same value. Live,
  // a native filter's `"matchValue": 9007199254740993` became ...992 in the stored
  // plan, which is what the raw-JSON tab and the AI analyzer then read.
  test("extractPlan keeps a 64-bit filter value exact through the inner parse", () => {
    const exact = "9007199254740993";
    const plan = `[{"query":{"queryType":"scan","dataSource":{"type":"table","name":"libredb_demo"},"filter":{"type":"equals","column":"snowflake_id","matchValueType":"LONG","matchValue":${exact}}}}]`;

    // The premise: a plain parse of this same text really does corrupt the value.
    const naive = JSON.stringify(JSON.parse(plan));
    expect(naive).not.toContain(exact);

    const stored = JSON.stringify(druidNativeStrategy.extractPlan({ rows: [{ PLAN: plan }] }));
    expect(stored).toContain(exact);
    expect(stored).not.toContain("9007199254740992");
  });

  test("extractPlan keeps a column's text when its JSON cannot be parsed", () => {
    expect(druidNativeStrategy.extractPlan({ rows: [{ PLAN: "[{ oops", RESOURCES: "", ATTRIBUTES: "{" }] })).toEqual({
      plan: "[{ oops",
      resources: "",
      attributes: "{",
    });
  });

  test("extractPlan tolerates any of the three columns being absent", () => {
    expect(druidNativeStrategy.extractPlan({ rows: [{ PLAN: "[]" }] })).toEqual({
      plan: [],
      resources: undefined,
      attributes: undefined,
    });
    expect(druidNativeStrategy.extractPlan({ rows: [{ ATTRIBUTES: '{"statementType":"SELECT"}' }] })).toEqual({
      plan: undefined,
      resources: undefined,
      attributes: { statementType: "SELECT" },
    });
  });

  // A non-string cell cannot be JSON text; it is not a column this strategy owns.
  test("extractPlan ignores a column whose cell is not text", () => {
    expect(druidNativeStrategy.extractPlan({ rows: [{ PLAN: 7, RESOURCES: null, ATTRIBUTES: "[]" }] })).toEqual({
      plan: undefined,
      resources: undefined,
      attributes: [],
    });
  });

  // Nothing recognisable to unwrap: hand the rows through so the raw tab still
  // shows what the server sent.
  test("extractPlan falls back to the raw rows when none of the three columns is present", () => {
    const rows = [{ nope: 1 }];
    expect(druidNativeStrategy.extractPlan({ rows })).toEqual(rows);
    expect(druidNativeStrategy.extractPlan({ rows: [] })).toEqual([]);
    expect(druidNativeStrategy.extractPlan({})).toBeUndefined();
  });

  // The tree carries no metrics anywhere: Druid's planner emits no cost and no row
  // estimate, and ExplainTreeNode.metrics is optional, so leaving it out is what
  // keeps the render honest rather than showing fabricated zeros.
  test("toRenderModel builds the join tree and puts no metrics on any node", () => {
    const model = druidNativeStrategy.toRenderModel(stored(LIVE_JOIN_PLAN));
    expect(model).toEqual({ kind: "tree", root: expect.anything(), raw: stored(LIVE_JOIN_PLAN) });
    const root = (model as { root: ExplainTreeNode }).root;
    expect(spineLabels(root)).toEqual(["groupBy", 'join INNER on ("region" == "j0.d0")', "table libredb_demo"]);
    const nodes: ExplainTreeNode[] = [];
    const walk = (node: ExplainTreeNode) => {
      nodes.push(node);
      node.children.forEach(walk);
    };
    walk(root);
    expect(nodes.every((node) => node.metrics === undefined)).toBe(true);
  });

  test("toRenderModel names the query type at the root and hangs the dataSource off it", () => {
    const root = treeRoot(stored(LIVE_JOIN_PLAN));
    expect(labels(root.children)).toEqual([
      'join INNER on ("region" == "j0.d0")',
      "granularity: all",
      "filter: range on qty",
      "dimensions: region AS d0",
      "aggregations: count AS a0",
    ]);
  });

  // rightPrefix is what disambiguates the right leg's columns in the join
  // condition; it is secondary to the condition itself, so it goes in detail.
  test("toRenderModel walks both legs of a join and keeps rightPrefix as detail", () => {
    const join = treeRoot(stored(LIVE_JOIN_PLAN)).children[0];
    expect(join.detail).toBe("rightPrefix: j0.");
    expect(labels(join.children)).toEqual(["table libredb_demo", "query"]);
    const subquery = join.children[1];
    expect(labels(subquery.children)).toEqual(["groupBy"]);
    expect(labels(subquery.children[0].children)).toEqual([
      "table libredb_rollup",
      "granularity: all",
      "dimensions: region AS d0",
    ]);
  });

  test("toRenderModel renders end to end from what extractPlan stored", () => {
    const root = treeRoot(druidNativeStrategy.extractPlan(explainResult(LIVE_JOIN_PLAN)));
    expect(root.label).toBe("groupBy");
  });

  test("toRenderModel renders the simplest scan plan as a query over one table", () => {
    const root = treeRoot(stored(LIVE_SCAN_PLAN));
    expect(root.label).toBe("scan");
    expect(labels(root.children)).toEqual(["table libredb_demo", "granularity: all"]);
    expect(root.children[0].children).toEqual([]);
  });

  // dimensions: [] is live on the outer groupBy here, and an empty row would say
  // nothing, so it is omitted rather than rendered blank.
  test("toRenderModel renders a subquery dataSource and omits an empty dimensions list", () => {
    const root = treeRoot(stored(LIVE_SUBQUERY_PLAN));
    expect(spineLabels(root)).toEqual(["groupBy", "query", "groupBy", "table libredb_demo"]);
    expect(labels(root.children)).toEqual(["query", "granularity: all", "aggregations: count AS a0"]);
  });

  test("toRenderModel renders every branch of a union dataSource", () => {
    const root = treeRoot(stored(LIVE_UNION_PLAN));
    const union = root.children[0];
    expect(union.label).toBe("union (2 sources)");
    expect(labels(union.children)).toEqual(["table libredb_demo", "table libredb_rollup"]);
  });

  test("toRenderModel reads topN's singular dimension as well as groupBy's array", () => {
    const root = treeRoot(stored(LIVE_TOPN_PLAN));
    expect(root.label).toBe("topN");
    expect(labels(root.children)).toEqual([
      "table libredb_demo",
      "granularity: all",
      "dimensions: region AS d0",
      "aggregations: count AS a0",
    ]);
  });

  // Live: TIME_FLOOR turns granularity into a bare string and dimensions into
  // explicit null, which no other plan shape shows.
  test("toRenderModel reads a bare-string granularity and tolerates a null dimensions field", () => {
    const root = treeRoot(stored(LIVE_TIMESERIES_PLAN));
    expect(root.label).toBe("timeseries");
    expect(labels(root.children)).toEqual(["table libredb_demo", "granularity: DAY", "aggregations: count AS a0"]);
  });

  // PLAN holds two independent native queries here, so a synthetic root is the
  // only way to show both without pretending one is the parent of the other.
  test("toRenderModel groups a multi-query plan under a synthetic root", () => {
    const root = treeRoot(stored(LIVE_TWO_QUERY_PLAN));
    expect(root).toMatchObject({ label: "2 native queries" });
    expect(labels(root.children)).toEqual(["groupBy", "groupBy"]);
    expect(labels(root.children[0].children)).toEqual([
      "table libredb_demo",
      "granularity: all",
      "dimensions: region AS d0",
      "aggregations: longSum(qty) AS a0",
    ]);
    expect(labels(root.children[1].children)).toEqual([
      "table libredb_rollup",
      "granularity: all",
      "dimensions: name AS d0",
      "aggregations: count AS a0",
    ]);
  });

  test("toRenderModel counts the rows of an inline dataSource and names its columns in detail", () => {
    const inline = treeRoot(stored(LIVE_INLINE_PLAN)).children[0];
    expect(inline).toEqual({ label: "inline (2 rows)", detail: "columns: x", children: [] });
  });

  test("toRenderModel accepts the plan at every wrapper depth storage may present", () => {
    expect(treeRoot(LIVE_SCAN_PLAN).label).toBe("scan");
    expect(treeRoot({ plan: LIVE_SCAN_PLAN }).label).toBe("scan");
    expect(treeRoot(JSON.stringify(LIVE_SCAN_PLAN)).label).toBe("scan");
    expect(treeRoot(JSON.stringify({ plan: LIVE_SCAN_PLAN })).label).toBe("scan");
  });

  test("toRenderModel skips a plan entry that carries no native query", () => {
    expect(treeRoot([{ signature: [] }, LIVE_SCAN_PLAN[0]]).label).toBe("scan");
    expect(treeRoot([7, { query: { queryType: 7 } }, LIVE_SCAN_PLAN[0]]).label).toBe("scan");
  });

  describe("dataSource types", () => {
    test("table without a name degrades to the bare type", () => {
      expect(dataSourceNode({ type: "table" })).toEqual({ label: "table", children: [] });
    });

    test("a query dataSource whose inner query is foreign renders as a leaf", () => {
      expect(dataSourceNode({ type: "query", query: { nope: 1 } })).toEqual({ label: "query", children: [] });
      expect(dataSourceNode({ type: "query" })).toEqual({ label: "query", children: [] });
    });

    test("join degrades when joinType or condition is missing", () => {
      expect(dataSourceNode({ type: "join", joinType: "LEFT" }).label).toBe("join LEFT");
      expect(dataSourceNode({ type: "join", condition: '("a" == "b")' }).label).toBe('join on ("a" == "b")');
      expect(dataSourceNode({ type: "join" })).toEqual({ label: "join", children: [] });
    });

    test("join drops a leg that is not a dataSource rather than rendering an empty node", () => {
      const join = dataSourceNode({ type: "join", left: { type: "table", name: "t" }, right: "nope" });
      expect(labels(join.children)).toEqual(["table t"]);
    });

    test("union tolerates a missing or foreign dataSources list", () => {
      expect(dataSourceNode({ type: "union" })).toEqual({ label: "union (0 sources)", children: [] });
      expect(dataSourceNode({ type: "union", dataSources: "nope" })).toEqual({
        label: "union (0 sources)",
        children: [],
      });
      const union = dataSourceNode({ type: "union", dataSources: [7, { type: "table", name: "t" }] });
      expect(union.label).toBe("union (2 sources)");
      expect(labels(union.children)).toEqual(["table t"]);
    });

    // Lookups are not listed in the sidebar but stay queryable by typing SQL, so a
    // plan can still reach one.
    test("lookup names the lookup it reads", () => {
      expect(dataSourceNode({ type: "lookup", lookup: "region_names" })).toEqual({
        label: "lookup region_names",
        children: [],
      });
      expect(dataSourceNode({ type: "lookup" })).toEqual({ label: "lookup", children: [] });
    });

    test("inline tolerates a missing or foreign rows list and column names", () => {
      expect(dataSourceNode({ type: "inline" })).toEqual({ label: "inline (0 rows)", children: [] });
      expect(dataSourceNode({ type: "inline", rows: "nope", columnNames: "nope" })).toEqual({
        label: "inline (0 rows)",
        children: [],
      });
      expect(dataSourceNode({ type: "inline", rows: [[1]], columnNames: ["a", 7, ""] }).detail).toBe("columns: a");
    });

    // Live: `EXPLAIN PLAN FOR SELECT 1 AS c1` plans a one-row inline dataSource, and
    // the count is part of the only text the tree renderer shows.
    test("a count of one reads as singular", () => {
      expect(dataSourceNode({ type: "inline", rows: [[1]] }).label).toBe("inline (1 row)");
      expect(dataSourceNode({ type: "union", dataSources: [{ type: "table", name: "t" }] }).label).toBe(
        "union (1 source)",
      );
    });

    // EXTERN is rejected by the native engine ("Cannot use [EXTERN] with SQL engine
    // [native]"), so an external dataSource can only reach here from the MSQ task
    // engine. It is handled rather than left to the unknown-type leaf because the
    // shape is stable and naming the input source is what makes the node readable.
    test("external names its input source", () => {
      expect(dataSourceNode({ type: "external", inputSource: { type: "inline" } })).toEqual({
        label: "external inline",
        children: [],
      });
      expect(dataSourceNode({ type: "external", inputSource: 7 })).toEqual({ label: "external", children: [] });
      expect(dataSourceNode({ type: "external" })).toEqual({ label: "external", children: [] });
    });

    // Druid adds dataSource types between releases. Dropping one would make the
    // tree quietly lie about what runs, so an unrecognised type becomes a leaf
    // labelled with the type Druid actually sent.
    test("an unrecognised type renders as a leaf labelled with that type", () => {
      expect(dataSourceNode({ type: "unnest", base: { type: "table", name: "t" } })).toEqual({
        label: "unnest",
        children: [],
      });
    });

    test("a dataSource with no type at all still renders a leaf", () => {
      expect(dataSourceNode({ type: 7 })).toEqual({ label: "unknown", children: [] });
      expect(dataSourceNode({})).toEqual({ label: "unknown", children: [] });
    });

    test("a query with no dataSource renders its attribute rows only", () => {
      expect(labels(treeRoot(planOf({ queryType: "scan", granularity: { type: "all" } })).children)).toEqual([
        "granularity: all",
      ]);
      expect(treeRoot(planWithDataSource("libredb_demo"))).toEqual({ label: "scan", children: [] });
    });
  });

  describe("attribute rows", () => {
    test("granularity reads a period spec, falls back to the type and skips anything else", () => {
      const granularityRow = (granularity: unknown) =>
        labels(treeRoot(planOf({ queryType: "scan", granularity })).children);
      expect(granularityRow({ type: "period", period: "P1D", timeZone: "UTC" })).toEqual(["granularity: P1D"]);
      expect(granularityRow({ type: "all" })).toEqual(["granularity: all"]);
      expect(granularityRow({ period: 7 })).toEqual([]);
      expect(granularityRow(7)).toEqual([]);
      expect(granularityRow("")).toEqual([]);
    });

    test("filter names the column it restricts, or the number of clauses it combines", () => {
      const filterRow = (filter: unknown) => labels(treeRoot(planOf({ queryType: "scan", filter })).children);
      expect(filterRow({ type: "equals", column: "region", matchValue: "emea" })).toEqual(["filter: equals on region"]);
      expect(filterRow({ type: "and", fields: [{ type: "equals" }, { type: "range" }] })).toEqual([
        "filter: and (2 clauses)",
      ]);
      expect(filterRow({ type: "true" })).toEqual(["filter: true"]);
      expect(filterRow({ fields: [] })).toEqual(["filter: unknown (0 clauses)"]);
      expect(filterRow("qty > 5")).toEqual([]);
    });

    test("dimensions fall back to the output name and drop entries that name nothing", () => {
      const dimensionRow = (dimensions: unknown) =>
        labels(treeRoot(planOf({ queryType: "groupBy", dimensions })).children);
      expect(dimensionRow([{ type: "default", outputName: "d0" }])).toEqual(["dimensions: d0"]);
      expect(dimensionRow([{ type: "default", dimension: "region", outputName: "region" }])).toEqual([
        "dimensions: region",
      ]);
      expect(dimensionRow([{ type: "default", dimension: "region" }])).toEqual(["dimensions: region"]);
      expect(dimensionRow([7, {}, { dimension: "qty", outputName: "d1" }])).toEqual(["dimensions: qty AS d1"]);
      expect(dimensionRow([7])).toEqual([]);
    });

    test("aggregations name the aggregated column and drop entries with no type", () => {
      const aggregationRow = (aggregations: unknown) =>
        labels(treeRoot(planOf({ queryType: "groupBy", aggregations })).children);
      expect(aggregationRow([{ type: "longMax", name: "a0", fieldName: "qty" }])).toEqual([
        "aggregations: longMax(qty) AS a0",
      ]);
      expect(aggregationRow([{ type: "count" }])).toEqual(["aggregations: count"]);
      expect(aggregationRow([{ type: "count", name: "a0" }, 7, { name: "a1" }])).toEqual(["aggregations: count AS a0"]);
      expect(aggregationRow("count")).toEqual([]);
    });
  });

  // Depth is bounded so a plan that somehow nests without end cannot recurse away
  // the stack. The bound is far past any real plan - the deepest live one is three
  // dataSource hops - so it only ever fires on a pathological shape.
  test("toRenderModel bounds the dataSource recursion depth", () => {
    const deep = spineLabels(treeRoot(nestedQueryChain(40)));
    expect(deep.at(-1)).toBe("plan truncated: nesting limit reached");
    expect(deep.length).toBeLessThan(70);
    // A chain that stays inside the bound still reaches its table.
    expect(spineLabels(treeRoot(nestedQueryChain(3))).at(-1)).toBe("table libredb_demo");
  });

  test("toRenderModel rejects shapes that are not Druid plans", () => {
    expect(druidNativeStrategy.toRenderModel(null)).toBeNull();
    expect(druidNativeStrategy.toRenderModel(undefined)).toBeNull();
    expect(druidNativeStrategy.toRenderModel(7)).toBeNull();
    expect(druidNativeStrategy.toRenderModel([])).toBeNull();
    expect(druidNativeStrategy.toRenderModel({})).toBeNull();
    expect(druidNativeStrategy.toRenderModel({ plan: undefined })).toBeNull();
    expect(druidNativeStrategy.toRenderModel([{ signature: [] }])).toBeNull();
    expect(druidNativeStrategy.toRenderModel([{ id: 3, parent: 0, detail: "SCAN users" }])).toBeNull();
  });

  test("toRenderModel rejects column text that is not JSON, and a pathological wrapper chain", () => {
    expect(druidNativeStrategy.toRenderModel("[{ oops")).toBeNull();
    expect(druidNativeStrategy.toRenderModel("")).toBeNull();
    expect(druidNativeStrategy.toRenderModel({ plan: { plan: { plan: { plan: LIVE_SCAN_PLAN } } } })).toBeNull();
  });
});
