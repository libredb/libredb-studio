import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { classifySelectPrefix } from "./select-prefix";
import type { ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * This strategy's dialect, resolved once. Reached only through
 * `explainFormat: "duckdb-json"`, which only the DuckDB provider declares, so the
 * module's identity IS the dialect - the same shape as a provider passing `this.type`.
 */
const DUCKDB_GRAMMAR = resolveSqlGrammar("duckdb");

/**
 * The prefix, and the decision behind it.
 *
 * DuckDB has two explain forms and they are not two renderings of one thing. Measured
 * on v1.5.5 (@duckdb/node-api 1.5.5-r.4), each in the only way that settles it:
 *
 * - `EXPLAIN (FORMAT JSON) <statement>` PLANS and never runs.
 *   `EXPLAIN (FORMAT JSON) INSERT INTO probe VALUES (7)` returned an `INSERT` plan and
 *   left the table's row count where it was.
 * - `EXPLAIN (ANALYZE, FORMAT JSON) <statement>` EXECUTES it. Same probe, other
 *   direction: `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO probe VALUES (42)` took the
 *   count from 0 to 1, and `EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET x = 2` really
 *   changed the row.
 *
 * So only the first form is ever emitted, and the mode parameter is ignored rather
 * than declined: the direct Explain action always builds with mode "analyze" and
 * refuses the run when the strategy returns null, so declining that mode would switch
 * the feature off instead of narrowing it, while emitting the analyze form would run a
 * statement the user only asked to see. The background estimate fires on every SELECT,
 * which makes the difference a cost as well as a hazard.
 *
 * The analyze form is unreliable on top of that: it answers the literal payload
 * `{"result": "error"}` on some runs instead of a plan (measured for the INSERT above,
 * and for `SELECT count(*) FROM customers` on a read-only connection, while other
 * statements on those same connections produced a real profile). Its shape is a single
 * OBJECT under the key `analyzed_plan`, not the array of `physical_plan` this reader
 * expects. Nothing here therefore ever reports an ACTUAL row count or timing - the
 * tree carries the planner's estimate and says nothing it has not been told.
 */
const EXPLAIN_PREFIX = "EXPLAIN (FORMAT JSON) ";

/**
 * The plan column of the one row an EXPLAIN returns; its value is the plan as JSON
 * text. The row carries a second column, `explain_key`, whose value is
 * `"physical_plan"` for this form - it names the form rather than the plan, so it is
 * not read.
 */
const EXPLAIN_COLUMN = "explain_value";

/**
 * The one `extra_info` entry that is a measurement rather than a description: it
 * becomes the node's row estimate instead of part of its label.
 */
const CARDINALITY_KEY = "Estimated Cardinality";

/**
 * How many wrapper layers toRoots peels before giving up. The only legitimate hop is
 * the cell text, so the extra layers exist for a tab that stored the value differently
 * and the ceiling only keeps a pathological chain from looping.
 */
const MAX_UNWRAP_DEPTH = 3;

/**
 * How deep the child recursion may go. The deepest plan measured on the live fixture is
 * nine nodes; this is far past anything the optimizer emits and fires only on a payload
 * that nests without end.
 */
const MAX_PLAN_DEPTH = 64;

/** What the tree says where MAX_PLAN_DEPTH stopped it, so truncation is visible rather than silent. */
const TRUNCATED_LABEL = "plan truncated: nesting limit reached";

/**
 * One node of a DuckDB physical plan. Measured over six statements, a node carries
 * exactly three keys - `name`, `children` and `extra_info` - and `name` is the
 * discriminator. The other two are still read defensively: `extra_info` is absent from
 * nothing measured but describes nothing on a `DUMMY_SCAN`, and `children` is an empty
 * array on every leaf.
 */
interface DuckDBPlanNode {
  name: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanNode(value: unknown): value is DuckDBPlanNode {
  return isRecord(value) && typeof value.name === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The plan's root nodes.
 *
 * The parsed cell is an ARRAY on the wire - measured as a one-element array on all six
 * statements probed, including a UNION ALL, two scalar subqueries and a RECURSIVE CTE -
 * so the array is peeled to its members rather than to `[0]`, and a payload that really
 * carried several roots would show all of them.
 *
 * A bare node is accepted too, and - because the result cell is a String holding JSON,
 * and an older tab may have stored it unparsed - so is the still-unparsed text, up to
 * MAX_UNWRAP_DEPTH. Anything else, including the `{"result":"error"}` the analyze form
 * answers on a failed profile, is not a plan.
 */
function toRoots(raw: unknown): DuckDBPlanNode[] | null {
  let current = raw;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (isPlanNode(current)) return [current];
    if (Array.isArray(current)) {
      const nodes = current.filter(isPlanNode);
      return nodes.length > 0 ? nodes : null;
    }
    if (typeof current === "string") {
      current = parseJsonText(current);
    } else {
      return null;
    }
  }
  return null;
}

/**
 * One `extra_info` value as text, or undefined where it describes nothing.
 *
 * Values are STRINGS on the wire, except that a multi-column entry is an ARRAY of
 * strings - `"Projections": ["id", "name"]` beside `"Table": "warehouse.main.customers"`
 * in the same node, both measured. An empty string, an empty list and anything that is
 * neither are dropped: keeping them would push the entry that identifies the node off
 * the end of the row.
 */
function readInfoValue(value: unknown): string | undefined {
  if (isNonEmptyString(value)) return value;
  if (Array.isArray(value)) {
    const items = value.filter(isNonEmptyString);
    return items.length > 0 ? items.join(", ") : undefined;
  }
  return undefined;
}

/**
 * `SEQ_SCAN (Table: warehouse.main.customers | Type: Sequential Scan | Projections: id, name)`.
 *
 * `Key: value` is how DuckDB's own box-drawing plan writes an extra_info line, and
 * matching the engine's rendering is deliberate: a user comparing this tree with
 * `EXPLAIN` output from the CLI must not have to translate between two spellings of the
 * same node. The entries are separated by `|` rather than `,` because an array value is
 * itself comma-joined.
 *
 * VisualExplain's tree view renders the label and the metrics and nothing else, so what
 * distinguishes two nodes of the same operator has to live here rather than in `detail`.
 */
function buildLabel(node: DuckDBPlanNode): string {
  const info = node.extra_info;
  if (!isRecord(info)) return node.name;
  const entries: string[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (key === CARDINALITY_KEY) continue;
    const text = readInfoValue(value);
    if (text !== undefined) entries.push(`${key}: ${text}`);
  }
  return entries.length > 0 ? `${node.name} (${entries.join(" | ")})` : node.name;
}

/**
 * The optimizer's row estimate for this node, or undefined where it published none.
 *
 * Only `estRows`. DuckDB's physical plan carries no cost figure at all, and it carries
 * no actual rows or timings either because the analyze form is never emitted - so a
 * node with no `Estimated Cardinality`, which `TOP_N` really is in the measured plan,
 * shows no metric badge rather than a fabricated zero.
 *
 * The value is a STRING (`"5"`), so it is read out and checked rather than assigned
 * across: a non-numeric one is dropped instead of rendering NaN.
 */
function readMetrics(node: DuckDBPlanNode): ExplainTreeNode["metrics"] {
  const info = node.extra_info;
  if (!isRecord(info)) return undefined;
  const text = readInfoValue(info[CARDINALITY_KEY]);
  if (text === undefined) return undefined;
  const estRows = Number(text);
  return Number.isFinite(estRows) ? { estRows } : undefined;
}

function toTreeNode(node: DuckDBPlanNode, depth: number): ExplainTreeNode {
  if (depth >= MAX_PLAN_DEPTH) return { label: TRUNCATED_LABEL, children: [] };
  const children = Array.isArray(node.children) ? node.children.filter(isPlanNode) : [];
  const tree: ExplainTreeNode = {
    label: buildLabel(node),
    children: children.map((child) => toTreeNode(child, depth + 1)),
  };
  const metrics = readMetrics(node);
  if (metrics !== undefined) tree.metrics = metrics;
  return tree;
}

export const duckdbJsonStrategy: ExplainStrategy = {
  format: "duckdb-json",
  buildSql(sql) {
    // DuckDB's planning EXPLAIN describes without running (see EXPLAIN_PREFIX), so
    // classification alone is the whole policy - there is no data-modifying-CTE hazard
    // to screen for the way PostgreSQL has, because nothing executes.
    //
    // The grammar is still passed, for the honest reading rather than for safety.
    // Measured on 1.5.5: block comments NEST (`/* a /* b */ still */` is all comment)
    // and `#` opens nothing (`SELECT 1 # note` is a Parser Error), and both differ from
    // the dialect-less default - so a reader given no dialect classifies
    // `/* a /* b */ SELECT 1 */ DELETE FROM t` as a SELECT, which is a dishonest
    // classification even where nothing runs.
    if (classifySelectPrefix(sql, DUCKDB_GRAMMAR) === null) return null;
    return `${EXPLAIN_PREFIX}${sql}`;
  },
  // The envelope parse leaves the cell as a String whose value is JSON, so the plan
  // needs a second parse. It happens here rather than at render time so the stored
  // value feeds the raw JSON and AI tabs as a structure instead of one escaped blob.
  extractPlan(result) {
    const cell = result.rows?.[0]?.[EXPLAIN_COLUMN];
    if (typeof cell !== "string") return result.rows;
    return parseJsonText(cell) ?? cell;
  },
  toRenderModel(raw) {
    const roots = toRoots(raw);
    if (roots === null) return null;
    const trees = roots.map((node) => toTreeNode(node, 0));
    // One root is what every measured statement plans to, so it is shown as itself. A
    // synthetic parent is only for the array shape the wire allows: naming it is the
    // only way to show several roots without pretending one is the parent of the rest.
    const root = trees.length === 1 ? trees[0] : { label: `${trees.length} plans`, children: trees };
    return { kind: "tree", root, raw };
  },
};
