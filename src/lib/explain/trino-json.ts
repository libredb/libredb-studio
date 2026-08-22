import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { classifySelectPrefix } from "./select-prefix";
import type { ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * This strategy's dialect, resolved once. Reached only through
 * `explainFormat: "trino-json"`, which only the Trino provider declares, so the
 * module's identity IS the dialect - the same shape as a provider passing `this.type`.
 */
const TRINO_GRAMMAR = resolveSqlGrammar("trino");

/**
 * The prefix, and the decision behind it.
 *
 * Trino has TWO explain forms and they are not two renderings of one thing:
 *
 * - `EXPLAIN (FORMAT JSON) <statement>` PLANS and never runs. Live-verified on 476 in
 *   the only way that settles it - `EXPLAIN (FORMAT JSON) INSERT INTO
 *   memory.default.probe VALUES (42)` finished, and `SELECT count(*)` on that table
 *   still answered 0.
 * - `EXPLAIN ANALYZE <statement>` EXECUTES it. Same probe, other direction:
 *   `EXPLAIN ANALYZE INSERT INTO memory.default.probe VALUES (7)` took the count from
 *   0 to 1.
 *
 * So only the first form is emitted, for BOTH modes. Two reasons, either of which
 * would be enough. The background estimate fires on every SELECT a user runs
 * (`use-query-execution.ts`), and a query engine's statements reach S3, Iceberg and
 * Hive - running one twice to draw a picture is a real bill, not a rounding error.
 * And `EXPLAIN ANALYZE` accepts no FORMAT option at all in 476
 * (`EXPLAIN ANALYZE (FORMAT JSON) …` is "line 1:18: mismatched input 'FORMAT'"), so
 * its output is the box-drawing TEXT plan - nothing this tree model could read without
 * a parser for it.
 *
 * The mode parameter is therefore ignored rather than declined: the direct Explain
 * action always builds with mode "analyze" and refuses the run when the strategy
 * returns null, so declining that mode would switch the feature off instead of
 * narrowing it. The SQLite, Couchbase, ClickHouse and Druid strategies all read the
 * same way.
 */
const EXPLAIN_PREFIX = "EXPLAIN (FORMAT JSON) ";

/** The one column of the one row Trino returns for an EXPLAIN; the cell is JSON text. */
const EXPLAIN_COLUMN = "Query Plan";

/**
 * How many wrapper layers toFragments peels before giving up. The only legitimate hop
 * is the cell text, so the extra layers exist for a tab that stored the value
 * differently and the ceiling only keeps a pathological chain from looping.
 */
const MAX_UNWRAP_DEPTH = 3;

/**
 * How deep the child recursion may go. Trino's deepest real plan here is a handful of
 * nodes; this is far past anything a planner emits and fires only on a payload that
 * nests without end.
 */
const MAX_PLAN_DEPTH = 64;

/** What the tree says where MAX_PLAN_DEPTH stopped it, so truncation is visible rather than silent. */
const TRUNCATED_LABEL = "plan truncated: nesting limit reached";

/**
 * Descriptor values that describe NOTHING, and are therefore dropped from the label.
 *
 * Not a tidying choice: Trino's own text renderer drops them. Its plan for
 * `SELECT count(*) FROM tpch.sf1.nation` prints `Aggregate[type = FINAL]` where the
 * JSON descriptor also carries `"keys": ""` and `"hash": "[]"`, and
 * `LocalExchange[partitioning = SINGLE]` where the descriptor also carries
 * `isReplicateNullsAndAny`, `hashColumn` and `arguments` - all empty. Keeping them
 * would push the one entry that identifies the node off the end of the row.
 */
const EMPTY_DESCRIPTOR_VALUES: ReadonlySet<string> = new Set(["", "[]", "{}"]);

/**
 * One node of a Trino plan fragment. `name` is the operator and is the discriminator;
 * everything else is optional on the wire (a `RemoteSource` carries no estimates, a
 * `Values` carries an empty descriptor).
 */
interface TrinoPlanNode {
  name: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanNode(value: unknown): value is TrinoPlanNode {
  return isRecord(value) && typeof value.name === "string";
}

/**
 * A real, usable number.
 *
 * The guard that matters, and it is measured rather than defensive: a cost Trino could
 * not compute arrives as the STRING `"NaN"`, not as a number and not as null - live,
 * the PARTIAL aggregate of a two-fragment count plan reports
 * `"cpuCost" : "NaN"`. Reading that as a metric would print "NaN" beside a node whose
 * row estimate is perfectly real.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The fragment map: `{ "0": <node>, "1": <node>, … }`, keyed by fragment id.
 *
 * Accepts the map itself and - because the result cell is a String holding JSON, and
 * an older tab may have stored it unparsed - the still-unparsed text, up to
 * MAX_UNWRAP_DEPTH. A map with no plan node in it is not a plan.
 */
function toFragments(raw: unknown): Array<[string, TrinoPlanNode]> | null {
  let current = raw;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (isRecord(current)) {
      const entries = Object.entries(current).filter((entry): entry is [string, TrinoPlanNode] => isPlanNode(entry[1]));
      return entries.length > 0 ? entries : null;
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
 * `Output[columnNames = [_col0]]`, which is exactly how Trino's own text plan writes
 * it. Matching the engine's rendering is deliberate: a user comparing this tree with
 * `EXPLAIN` output pasted from the CLI must not have to translate between two spellings
 * of the same node.
 */
function buildLabel(node: TrinoPlanNode): string {
  const descriptor = node.descriptor;
  if (!isRecord(descriptor)) return node.name;
  const entries = Object.entries(descriptor)
    .filter(([, value]) => typeof value === "string" && !EMPTY_DESCRIPTOR_VALUES.has(value))
    .map(([key, value]) => `${key} = ${value as string}`);
  return entries.length > 0 ? `${node.name}[${entries.join(", ")}]` : node.name;
}

/**
 * The planner's estimate for this node, or undefined where it published none.
 *
 * `estimates` is an ARRAY on the wire and the first entry is the node's own; the
 * remaining entries belong to a node with several sources, which the tree already
 * shows as separate children. An empty array is what a `RemoteSource` carries, and it
 * means the estimate lives in the fragment this one reads from.
 *
 * Cost is `cpuCost` rather than a sum: it is the figure Trino's own text plan leads
 * its `Estimates: {…}` line with after the row count, and adding three costs of
 * different units together would produce a number the engine never claims.
 */
function readMetrics(node: TrinoPlanNode): ExplainTreeNode["metrics"] {
  const first = Array.isArray(node.estimates) ? node.estimates[0] : undefined;
  if (!isRecord(first)) return undefined;
  const metrics: NonNullable<ExplainTreeNode["metrics"]> = {};
  if (isFiniteNumber(first.outputRowCount)) metrics.estRows = first.outputRowCount;
  if (isFiniteNumber(first.cpuCost)) metrics.estCost = first.cpuCost;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/**
 * `details` is Trino's own per-node prose - the assignments and the predicate, e.g.
 * `count := count(count_0)`. It is joined rather than turned into child rows because
 * these lines describe THIS node, unlike ClickHouse's index entries, which each
 * deserve their own row.
 */
function readDetail(node: TrinoPlanNode): string | undefined {
  const details = Array.isArray(node.details) ? node.details.filter((line) => typeof line === "string") : [];
  return details.length > 0 ? details.join(" | ") : undefined;
}

function toTreeNode(node: TrinoPlanNode, depth: number): ExplainTreeNode {
  if (depth >= MAX_PLAN_DEPTH) return { label: TRUNCATED_LABEL, children: [] };
  const children = Array.isArray(node.children) ? node.children.filter(isPlanNode) : [];
  const tree: ExplainTreeNode = {
    label: buildLabel(node),
    children: children.map((child) => toTreeNode(child, depth + 1)),
  };
  const detail = readDetail(node);
  if (detail !== undefined) tree.detail = detail;
  const metrics = readMetrics(node);
  if (metrics !== undefined) tree.metrics = metrics;
  return tree;
}

/**
 * Numeric where both ids are numbers, textual otherwise.
 *
 * `Object.keys` hands the fragments back in insertion order, and a plain string sort
 * puts fragment 10 between 1 and 2 - which on a join-heavy statement is an everyday
 * plan, not an exotic one. The textual fallback only matters if a future release keys
 * a fragment by something other than a number.
 */
function compareFragmentIds(left: string, right: string): number {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return left.localeCompare(right);
}

export const trinoJsonStrategy: ExplainStrategy = {
  format: "trino-json",
  buildSql(sql) {
    // Trino's EXPLAIN describes without running (see EXPLAIN_PREFIX), so classification
    // alone is the whole policy - there is no data-modifying-CTE hazard to screen for
    // the way PostgreSQL has, and not only because nothing executes: Trino's grammar
    // refuses one outright. `WITH t AS (INSERT INTO … ) SELECT 1` is "line 1:12:
    // mismatched input 'INSERT'. Expecting: <query>".
    //
    // The grammar is still passed, for the honest reading rather than for safety:
    // block comments are FLAT here and `#` opens nothing, so a dialect-less reader
    // would classify `/* a /* b */ SELECT 1` as unexplainable and hide the button on a
    // statement Trino explains fine.
    if (classifySelectPrefix(sql, TRINO_GRAMMAR) === null) return null;
    return `${EXPLAIN_PREFIX}${sql}`;
  },
  // The envelope parse leaves the cell as a String whose value is JSON, so the plan
  // needs a second parse. It happens here rather than at render time so the stored
  // value feeds the raw JSON and AI tabs as a structure instead of one escaped blob.
  //
  // No integer requoting, unlike the Druid strategy: every number in this payload is a
  // DOUBLE, which cannot lose precision the way a bare 64-bit integer does. Measured on
  // 476 - `tpch.sf1.lineitem` plans with `"outputRowCount" : 6001215.0` and
  // `"outputSizeInBytes" : 7.83988912E8`, and the ids (`"id" : "183"`) are strings.
  extractPlan(result) {
    const cell = result.rows?.[0]?.[EXPLAIN_COLUMN];
    if (typeof cell !== "string") return result.rows;
    return parseJsonText(cell) ?? cell;
  },
  toRenderModel(raw) {
    const fragments = toFragments(raw);
    if (fragments === null) return null;
    const roots = fragments
      .sort(([left], [right]) => compareFragmentIds(left, right))
      .map(([id, node]) => ({ label: `Fragment ${id}`, children: [toTreeNode(node, 0)] }));
    // A fragment is a real boundary - it is where a `RemoteSource` hands off to another
    // stage - so each one is named even when there is only one, which is also what
    // Trino's own text plan does ("Fragment 0 [SINGLE]"). A synthetic root above them
    // is the only way to show several without pretending one is the parent of the rest.
    const root = roots.length === 1 ? roots[0] : { label: `${roots.length} fragments`, children: roots };
    return { kind: "tree", root, raw };
  },
};
