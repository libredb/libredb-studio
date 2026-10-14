import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { classifySelectPrefix } from "./select-prefix";
import { buildTree, cellText, isRecord, type PlanLine, withRoot } from "./text-plan";
import type { ExplainPlanInput, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * This strategy's dialect, resolved once. Reached only through `explainFormat: "spark-text"`, which only the Apache
 * Spark provider declares, so the module's identity is the dialect.
 */
const SPARK_GRAMMAR = resolveSqlGrammar("spark");

const PHYSICAL_PLAN = "== Physical Plan ==";

/**
 * The leading run that means "deeper": spaces and the glyphs Spark draws its trees with, `+-`, `:-`, `:` and `|`.
 * `text-plan.ts`'s `INDENT` is not reused: it covers the box glyphs other engines draw, not these.
 */
const TREE_PREFIX = /^(?: |:-|\+-|:|\|)*/;

/** A numbered section's header, `(n) Name`. */
const SECTION_HEADER = /^\((\d+)\) /;

/** The number a tree line's label ends with, `Name (n)`. */
const NODE_NUMBER = /\((\d+)\)$/;

/** The numbered sections below the tree: each `(n) Name` and its `Key: value` lines up to a blank line, by number. */
function sectionDetails(lines: readonly string[]): Map<string, string> {
  const details = new Map<string, string>();
  let number: string | undefined;
  let body: string[] = [];
  const close = () => {
    if (number !== undefined) details.set(number, body.join("\n"));
    number = undefined;
    body = [];
  };
  for (const line of lines) {
    const header = SECTION_HEADER.exec(line);
    if (header !== null) {
      close();
      number = header[1];
    } else if (line.trim() === "") {
      close();
    } else if (number !== undefined) {
      body.push(line);
    }
  }
  close();
  return details;
}

/**
 * The tree of an `EXPLAIN FORMATTED` answer: the first column of its one row is the plan text, the lines between
 * `== Physical Plan ==` and the first blank line are the tree, each line's depth the length of its glyph run, and a
 * numbered section becomes the detail of the node whose label ends with its number. `null` on any other shape; it
 * never throws.
 */
function sparkPlanTree(raw: unknown): ExplainPlanInput | null {
  if (!Array.isArray(raw) || raw.length === 0 || !isRecord(raw[0])) return null;
  const text = cellText(Object.values(raw[0])[0]);
  const lines = text.split("\n");
  const start = lines.indexOf(PHYSICAL_PLAN);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  const details = sectionDetails(lines.slice(end));
  const planLines: PlanLine[] = lines.slice(start + 1, end).map((line) => {
    const indent = TREE_PREFIX.exec(line)?.[0].length ?? 0;
    const label = line.slice(indent).trimEnd();
    const number = NODE_NUMBER.exec(label)?.[1];
    const detail = number === undefined ? undefined : details.get(number);
    const node: ExplainTreeNode = detail === undefined ? { label, children: [] } : { label, detail, children: [] };
    return { indent, text: label, node };
  });
  if (planLines.length === 0) return null;
  // The raw tab shows the plan as Spark printed it.
  return { kind: "tree", root: withRoot(buildTree(planLines)), raw: text };
}

/**
 * Apache Spark's plan: `EXPLAIN FORMATTED`, which plans without running and starts no Spark job, in both modes; no
 * plan is asked for beside an ordinary run.
 */
export const sparkTextStrategy: ExplainStrategy = {
  format: "spark-text",
  backgroundPlan: false,
  buildSql: (sql) => (classifySelectPrefix(sql, SPARK_GRAMMAR) === null ? null : `EXPLAIN FORMATTED ${sql}`),
  extractPlan: (result) => result.rows ?? [],
  toRenderModel: (raw) => sparkPlanTree(raw),
};
