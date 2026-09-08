import { isExplainableUnderPostgresGrammar } from "./postgres-json";
import { INDENT, buildTree, cellText, isRecord, withRoot, type PlanLine } from "./text-plan";
import type { ExplainMode, ExplainPlanInput, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * Plain `EXPLAIN <sql>` for the PostgreSQL-wire relatives whose grammar refuses
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (issue #597). Measured 2026-09-06 through
 * `pg` 8.x, one connection per engine:
 *
 * - Materialize v26.40.0: `Expected SELECT, VALUES, or a subquery in the query body,
 *   found ANALYZE`, and the same refusal for a bare `(FORMAT JSON)` naming `FORMAT` -
 *   the PARENTHESES are what its grammar has no rule for, so dropping `ANALYZE` alone
 *   changes nothing. `EXPLAIN ANALYZE` is a different statement there entirely
 *   (`Expected one of CPU or MEMORY, found SELECT`), so this engine has no analyze
 *   mode to offer.
 * - CockroachDB v26.2.5: `at or near "analyze": syntax error`, and `at or near "json":
 *   syntax error` for `(FORMAT JSON)` - its option vocabulary is its own, and `JSON`
 *   in it is only legal beside `DISTSQL`, where it answers a DistSQL processor diagram
 *   rather than a plan. It does accept an unparenthesised `EXPLAIN ANALYZE`.
 * - PostgreSQL 18, TimescaleDB (PG 17.11), YugabyteDB 2.25.2, Apache Cloudberry 2.1.0
 *   and AlloyDB Omni (PG 17.9) all accept the parenthesised JSON form and never reach
 *   this strategy.
 *
 * Both engines that do reach it were showing the Explain panel's "no execution plan"
 * empty state, so the failure read as "this query has no plan" rather than as an
 * error - the panel was worse than broken, it was quietly wrong.
 */

/**
 * The bullet CockroachDB prints in front of a plan NODE, which is what tells its node
 * lines apart from the attribute lines that describe them.
 *
 * Its plan indents both with the same glyphs, so read by indentation alone
 * `└── • hash join` (indent 4) lands under `│ group by: name` (indent 2) - an
 * operator nested inside one of its parent's attributes. Where a plan marks its nodes,
 * the marker is the structure and everything between two markers describes the one
 * above.
 *
 * Materialize marks nothing this way (its `→` is on every plan line and its `Source`
 * and `Target cluster` sections carry no marker at all, so reading `→` as a marker
 * would file those sections under the deepest operator), and indentation alone nests
 * its plan correctly. So the rule is applied only to a plan that actually uses it.
 */
const NODE_MARKER = "•";

/** One printed line: what the engine wrote, and it stripped of the run that only means depth. */
interface TextLine {
  readonly indent: number;
  readonly label: string;
  readonly printed: string;
}

/**
 * The plan's lines, whichever way the engine returned them.
 *
 * CockroachDB answers one row per line in a column called `info`; Materialize answers
 * a single row whose one cell holds the whole plan with newlines in it. Both are the
 * same plan text, so the cell is split and the two shapes meet here. Only the FIRST
 * column is read: it is the plan on both, and neither publishes a second one.
 */
function toTextLines(rows: readonly Record<string, unknown>[]): TextLine[] {
  const lines: TextLine[] = [];
  for (const row of rows) {
    const cell = Object.values(row)[0];
    // A cell that is not text is not a printed plan - a `postgres-json` plan array
    // reaches here as records whose first value is the plan OBJECT, and stringifying
    // it would build a tree of "[object Object]" instead of refusing the shape.
    if (typeof cell !== "string") return [];
    for (const printed of cell.split("\n")) {
      // A `*` run anchored at the start always matches, so the prefix is simply what
      // stripping it removes: no null arm to guard.
      const label = printed.replace(INDENT, "");
      // Blank and glyph-only lines are the padding these plans use between sections;
      // a node built from one would be an empty box in the tree.
      if (label.trim() === "") continue;
      lines.push({ indent: printed.length - label.length, label, printed });
    }
  }
  return lines;
}

/**
 * Attribute lines folded into the node they describe. Applied only when the plan marks
 * its nodes; see `NODE_MARKER`.
 */
function foldAttributes(lines: readonly TextLine[]): PlanLine[] {
  const folded: PlanLine[] = [];
  const details: string[][] = [];
  for (const line of lines) {
    // A line before the first marked node describes nothing above it - CockroachDB
    // prints `distribution: local` and `plan type: custom` there - so it stays a node
    // of its own rather than being attached to a node that does not exist yet.
    if (line.label.startsWith(NODE_MARKER) || folded.length === 0) {
      folded.push({ indent: line.indent, text: line.label, node: { label: line.label, children: [] } });
      details.push([]);
      continue;
    }
    details[details.length - 1].push(line.label);
  }
  for (const [index, detail] of details.entries()) {
    if (detail.length > 0) folded[index].node.detail = detail.join(", ");
  }
  return folded;
}

/** Every line its own node, which is the right reading where nothing marks the nodes. */
function toPlanLines(lines: readonly TextLine[]): PlanLine[] {
  return lines.map((line) => ({
    indent: line.indent,
    text: line.label,
    node: { label: line.label, children: [] } as ExplainTreeNode,
  }));
}

function toRenderModel(raw: unknown): ExplainPlanInput | null {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isRecord)) return null;
  const lines = toTextLines(raw);
  if (lines.length === 0) return null;
  const marked = lines.some((line) => line.label.startsWith(NODE_MARKER));
  const planLines = marked ? foldAttributes(lines) : toPlanLines(lines);
  return {
    kind: "tree",
    root: withRoot(buildTree(planLines)),
    // The raw tab shows the plan as the engine printed it, glyphs and indentation
    // included - it is read beside the tree, not instead of it, and CockroachDB's
    // box-drawn plan is the clearest thing that engine publishes. Built from the
    // printed lines rather than the plan lines, so the attribute lines folded into a
    // node's detail above are still there. Only lines that carry nothing at all are
    // dropped: StarRocks pads a 17-line plan with 6 of them.
    raw: lines.map((line) => line.printed).join("\n"),
  };
}

/**
 * Neither engine here reads a plan differently from the other, so both strategies
 * share everything but the statement they ask for. The split exists because
 * CockroachDB has an `EXPLAIN ANALYZE` that reports what the query really did and
 * Materialize has none, and one capability names one grammar.
 */
const readsTextPlans = {
  extractPlan(result: { rows?: Array<Record<string, unknown>> }) {
    return result.rows ?? [];
  },
  toRenderModel,
} as const;

/**
 * The screen `postgres-json` applies, for the same reason: `EXPLAIN ANALYZE` RUNS what
 * it explains, a data-modifying CTE is a write wearing a `WITH`, and an explain run
 * skips the dangerous-query confirmation entirely. The plain `EXPLAIN` of
 * `postgres-text` executes nothing, but it is screened too - the two strategies must
 * refuse the same statements, or which engine you happen to be connected to would
 * decide whether the Explain button appears.
 */
function buildPlain(sql: string): string | null {
  return isExplainableUnderPostgresGrammar(sql) ? `EXPLAIN ${sql}` : null;
}

/** Bare `EXPLAIN`, the only plan grammar Materialize publishes. */
export const postgresTextStrategy: ExplainStrategy = {
  format: "postgres-text",
  buildSql: buildPlain,
  ...readsTextPlans,
};

/** The same, plus CockroachDB's unparenthesised `EXPLAIN ANALYZE` when one is asked for. */
export const postgresTextAnalyzeStrategy: ExplainStrategy = {
  format: "postgres-text-analyze",
  buildSql(sql: string, mode: ExplainMode) {
    const plain = buildPlain(sql);
    return plain !== null && mode === "analyze" ? `EXPLAIN ANALYZE ${sql}` : plain;
  },
  ...readsTextPlans,
};
