import { describe, expect, test } from "bun:test";
import { readIpcColumns } from "@/lib/db/providers/sql/spark/arrow";
import { getExplainStrategy } from "@/lib/explain";
import { sparkTextStrategy } from "@/lib/explain/spark-text";
import type { ExplainMode, ExplainTreeNode } from "@/lib/explain/types";
import { captureBytes, readSparkCapture, type SparkCaptureVersion } from "../../../helpers/spark-captures";

const MODES: readonly ExplainMode[] = ["estimate", "analyze"];

// Spark's answer to EXPLAIN FORMATTED for a grouped, sorted read of one parquet table, as measured.
const MEASURED = [
  "== Physical Plan ==",
  "AdaptiveSparkPlan (9)",
  "+- Sort (8)",
  "   +- Exchange (7)",
  "      +- HashAggregate (6)",
  "         +- Exchange (5)",
  "            +- HashAggregate (4)",
  "               +- Project (3)",
  "                  +- Filter (2)",
  "                     +- Scan parquet spark_catalog.p01db.t1 (1)",
  "",
  "",
  "(1) Scan parquet spark_catalog.p01db.t1",
  "Output [3]: [id#1481L, name#1482, day#1487]",
  "Batched: true",
  "ReadSchema: struct<id:bigint,name:string>",
  "",
  "(2) Filter",
  "Input [3]: [id#1481L, name#1482, day#1487]",
  "Condition : (isnotnull(id#1481L) AND (id#1481L > 0))",
  "",
  "(9) AdaptiveSparkPlan",
  "Output [2]: [name#1482, n#1523L]",
  "Arguments: isFinalPlan=false",
  "",
].join("\n");

// A join, in the form Spark draws every tree: `:-` before a child with a later sibling, `+-` before the last one, and
// `:` carrying the earlier sibling's column down.
const JOIN = [
  "== Physical Plan ==",
  "AdaptiveSparkPlan (6)",
  "+- BroadcastHashJoin Inner BuildRight (5)",
  "   :- Filter (2)",
  "   :  +- Scan parquet spark_catalog.studio.orders (1)",
  "   +- BroadcastExchange (4)",
  "      +- Scan parquet spark_catalog.studio.customers (3)",
  "",
  "",
  "(1) Scan parquet spark_catalog.studio.orders",
  "Output [2]: [id#1L, customer_id#2L]",
  "",
].join("\n");

const rows = (plan: string) => [{ plan }];
const model = (plan: string) => sparkTextStrategy.toRenderModel(sparkTextStrategy.extractPlan({ rows: rows(plan) }));

function flatten(node: ExplainTreeNode): ExplainTreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** The bytes of the first `local_relation.data` anywhere in a captured answer. */
function localRelationBytes(value: unknown): Uint8Array | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = localRelationBytes(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const relation = record.local_relation;
  if (typeof relation === "object" && relation !== null && "data" in relation) {
    return captureBytes((relation as { data: unknown }).data);
  }
  for (const child of Object.values(record)) {
    const found = localRelationBytes(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The plan text of a captured EXPLAIN FORMATTED answer: the first value of its one text column. */
function capturedPlan(version: SparkCaptureVersion): string {
  const capture = readSparkCapture(version, "explain-formatted");
  if (capture.outcome !== "pass") throw new Error(`the ${version} explain capture is an error capture`);
  const bytes = localRelationBytes(capture.payload);
  if (bytes === undefined) throw new Error(`the ${version} explain capture holds no local_relation data`);
  const [column] = readIpcColumns(bytes).columns;
  if (column?.offsets === undefined || column.values === undefined) throw new Error("the plan column is not text");
  return new TextDecoder().decode(column.values.subarray(column.offsets[0], column.offsets[1]));
}

describe("sparkTextStrategy", () => {
  test("is registered as spark-text and asks for no plan beside a run", () => {
    expect(getExplainStrategy("spark-text")).toBe(sparkTextStrategy);
    expect(sparkTextStrategy.format).toBe("spark-text");
    expect(sparkTextStrategy.backgroundPlan).toBe(false);
  });

  test("both modes send EXPLAIN FORMATTED for a statement led by SELECT or WITH", () => {
    for (const mode of MODES) {
      expect(sparkTextStrategy.buildSql("SELECT 1", mode)).toBe("EXPLAIN FORMATTED SELECT 1");
      expect(sparkTextStrategy.buildSql("WITH x AS (SELECT 1) SELECT * FROM x", mode)).toBe(
        "EXPLAIN FORMATTED WITH x AS (SELECT 1) SELECT * FROM x",
      );
      expect(sparkTextStrategy.buildSql("/* note */ SELECT 1", mode)).toBe("EXPLAIN FORMATTED /* note */ SELECT 1");
    }
  });

  test.each(["INSERT INTO t VALUES (1)", "SHOW TABLES", "DROP TABLE t", "BEGIN SELECT 1; END"])(
    "%j is not explained",
    (sql) => {
      for (const mode of MODES) expect(sparkTextStrategy.buildSql(sql, mode)).toBeNull();
    },
  );

  test("extractPlan hands over the rows", () => {
    expect(sparkTextStrategy.extractPlan({ rows: rows("x") })).toEqual(rows("x"));
    expect(sparkTextStrategy.extractPlan({})).toEqual([]);
  });

  test("the measured text becomes the tree, each node with its numbered details, and the raw text as printed", () => {
    const result = model(MEASURED);
    if (result?.kind !== "tree") throw new Error("expected a tree");
    const labels = flatten(result.root).map((node) => node.label);
    expect(labels).toEqual([
      "AdaptiveSparkPlan (9)",
      "Sort (8)",
      "Exchange (7)",
      "HashAggregate (6)",
      "Exchange (5)",
      "HashAggregate (4)",
      "Project (3)",
      "Filter (2)",
      "Scan parquet spark_catalog.p01db.t1 (1)",
    ]);
    const byLabel = new Map(flatten(result.root).map((node) => [node.label, node]));
    expect(byLabel.get("Scan parquet spark_catalog.p01db.t1 (1)")?.detail).toBe(
      "Output [3]: [id#1481L, name#1482, day#1487]\nBatched: true\nReadSchema: struct<id:bigint,name:string>",
    );
    expect(byLabel.get("Filter (2)")?.detail).toBe(
      "Input [3]: [id#1481L, name#1482, day#1487]\nCondition : (isnotnull(id#1481L) AND (id#1481L > 0))",
    );
    expect(byLabel.get("Sort (8)")?.detail).toBeUndefined();
    expect(result.raw).toBe(MEASURED);
  });

  test("`:-` and `:` place a join's two inputs side by side", () => {
    const result = model(JOIN);
    if (result?.kind !== "tree") throw new Error("expected a tree");
    const join = result.root.children[0];
    expect(join.label).toBe("BroadcastHashJoin Inner BuildRight (5)");
    expect(join.children.map((node) => node.label)).toEqual(["Filter (2)", "BroadcastExchange (4)"]);
    expect(join.children[0].children.map((node) => node.label)).toEqual([
      "Scan parquet spark_catalog.studio.orders (1)",
    ]);
    expect(join.children[1].children.map((node) => node.label)).toEqual([
      "Scan parquet spark_catalog.studio.customers (3)",
    ]);
  });

  test("a line with no number keeps no detail", () => {
    const result = model("== Physical Plan ==\nLocalTableScan [a#1]\n");
    if (result?.kind !== "tree") throw new Error("expected a tree");
    expect(result.root).toEqual({ label: "LocalTableScan [a#1]", children: [] });
  });

  test.each<[string, unknown]>([
    ["no rows", []],
    ["not rows", "== Physical Plan =="],
    ["a row that is not a record", [42]],
    ["text with no physical plan", rows("== Parsed Logical Plan ==\nProject")],
    ["a physical plan with no tree line", rows("== Physical Plan ==\n\n(1) Scan")],
  ])("%s is a foreign shape and gives null", (_label, raw) => {
    expect(sparkTextStrategy.toRenderModel(raw)).toBeNull();
  });

  test.each<SparkCaptureVersion>(["4.2.0", "4.1.3"])(
    "the captured EXPLAIN FORMATTED text of %s becomes its tree",
    (version) => {
      const text = capturedPlan(version);
      const lines = text.split("\n");
      const start = lines.indexOf("== Physical Plan ==");
      const treeLines = lines.slice(start + 1, lines.indexOf("", start + 1));
      const result = model(text);
      if (result?.kind !== "tree") throw new Error("expected a tree");
      const nodes = flatten(result.root);
      expect(nodes).toHaveLength(treeLines.length);
      for (const node of nodes) {
        expect(node.label).toMatch(/\(\d+\)$/);
        expect(node.detail ?? "").not.toBe("");
      }
      expect(result.raw).toBe(text);
    },
  );
});
