import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { classifySelectPrefix } from "./select-prefix";
import type { ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * This strategy's dialect, resolved once. Reached only through
 * `explainFormat: "clickhouse-json"`, which only the ClickHouse provider declares, so
 * the module's identity IS the dialect - the same shape as a provider passing
 * `this.type`.
 */
const CLICKHOUSE_GRAMMAR = resolveSqlGrammar("clickhouse");

/**
 * `FORMAT <Name>` where nothing but a `SETTINGS` clause or a semicolon follows it.
 *
 * The tail is a lookahead rather than part of the match, so only the FORMAT clause
 * is removed. `SETTINGS` is deliberately kept: it applies to the inner statement and
 * carries real meaning (`max_execution_time` and friends), whereas FORMAT would
 * reformat the EXPLAIN output itself and leave no JSON cell to parse.
 *
 * The tail is also why this is not simply anchored to the end: `... FORMAT TSV;` and
 * `... FORMAT TSV SETTINGS max_threads=1` are both statements `prepareQuery` already
 * treats as carrying a trailing FORMAT, so an end-anchored pattern silently disagreed
 * with it and left the plan unparseable.
 *
 * It still cannot match `formatDateTime(...)` (no whitespace after the word) or the
 * words inside a string literal (a quote is not an accepted tail). The provider
 * carries a related pattern for its own reason - it must not append a LIMIT past this
 * clause - and the duplication is deliberate: an explain strategy importing from one
 * provider would tie the registry to it.
 */
const TRAILING_FORMAT =
  /\s*\bFORMAT\s+[A-Za-z][A-Za-z0-9_]*(?=\s*(?:SETTINGS\s+[A-Za-z_][A-Za-z0-9_]*\s*=[\s\S]*?)?;?\s*$)/i;

/** The one column of the one row EXPLAIN returns; its value is the plan as JSON text. */
const EXPLAIN_COLUMN = "explain";

/**
 * How many wrapper layers toPlanRoot peels before giving up. The deepest legitimate
 * chain is four hops - cell text, the outer array, the { Plan } member, then the node
 * itself - so the extra layer only keeps a pathological chain from looping.
 */
const MAX_UNWRAP_DEPTH = 5;

/**
 * A node of a ClickHouse EXPLAIN plan. "Node Type" is the discriminator and children
 * always live under "Plans" as an array, so there is no single-child form to walk.
 */
interface ClickHousePlanNode {
  "Node Type": string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanNode(value: unknown): value is ClickHousePlanNode {
  return isRecord(value) && typeof value["Node Type"] === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
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
 * Accepts the node itself, the { Plan } member, the outer array and - because the
 * result cell is a String holding JSON - the still-unparsed plan text, in any nesting
 * up to MAX_UNWRAP_DEPTH.
 */
function toPlanRoot(raw: unknown): ClickHousePlanNode | null {
  let current = raw;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (isPlanNode(current)) return current;
    if (typeof current === "string") {
      current = parseJsonText(current);
    } else if (Array.isArray(current)) {
      current = current[0];
    } else if (isRecord(current) && "Plan" in current) {
      current = current.Plan;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * "Description" carries what distinguishes two nodes of the same type - the read
 * table, "preliminary LIMIT", the WHERE it folded in - and VisualExplain renders only
 * the label, so it belongs there rather than in detail.
 */
function buildLabel(node: ClickHousePlanNode): string {
  const description = node.Description;
  return isNonEmptyString(description) ? `${node["Node Type"]}: ${description}` : node["Node Type"];
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function buildRatio(unit: string, selected: unknown, initial: unknown): string | undefined {
  return isCount(selected) && isCount(initial) ? `${unit} ${selected}/${initial}` : undefined;
}

/** Selected-over-initial is the whole point of indexes = 1: it is what the index pruned. */
function buildIndexSelection(entry: Record<string, unknown>): string | undefined {
  const ratios = [
    buildRatio("parts", entry["Selected Parts"], entry["Initial Parts"]),
    buildRatio("granules", entry["Selected Granules"], entry["Initial Granules"]),
  ].filter(isNonEmptyString);
  return ratios.length > 0 ? ratios.join(", ") : undefined;
}

function buildIndexLabel(entry: Record<string, unknown>): string {
  // "Name" is present on data-skipping entries only; "Type" alone identifies the rest.
  const head = ["Index", entry.Type, entry.Name].filter(isNonEmptyString).join(" ");
  const keys = toStringList(entry.Keys);
  const named = keys.length > 0 ? `${head} (${keys.join(", ")})` : head;
  const selection = buildIndexSelection(entry);
  return selection === undefined ? named : `${named}: ${selection}`;
}

function buildIndexDetail(entry: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (isNonEmptyString(entry.Condition)) parts.push(`condition: ${entry.Condition}`);
  if (isNonEmptyString(entry["Search Algorithm"])) parts.push(`search: ${entry["Search Algorithm"]}`);
  // On a data-skipping entry "Description" is the index definition, e.g. "set GRANULARITY 4".
  if (isNonEmptyString(entry.Description)) parts.push(`definition: ${entry.Description}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * Index usage becomes child rows rather than one detail string: a MergeTree read
 * reports up to four entries (Min-Max, Partition, PrimaryKey and each skip index) and
 * each deserves its own line.
 */
function collectIndexNodes(node: ClickHousePlanNode): ExplainTreeNode[] {
  const indexes = node.Indexes;
  if (!Array.isArray(indexes)) return [];
  return indexes.filter(isRecord).map((entry) => {
    const indexNode: ExplainTreeNode = { label: buildIndexLabel(entry), children: [] };
    const detail = buildIndexDetail(entry);
    if (detail !== undefined) indexNode.detail = detail;
    return indexNode;
  });
}

function toTreeNode(node: ClickHousePlanNode): ExplainTreeNode {
  const plans = node.Plans;
  const children = Array.isArray(plans) ? plans.filter(isPlanNode).map(toTreeNode) : [];
  return { label: buildLabel(node), children: [...children, ...collectIndexNodes(node)] };
}

export const clickhouseJsonStrategy: ExplainStrategy = {
  format: "clickhouse-json",
  // json = 1 for the tree, indexes = 1 for what the primary key and skip indexes
  // pruned. actions = 1 is left out on purpose: it grew a two-table join plan roughly
  // tenfold with expression internals the tree model cannot show.
  //
  // ClickHouse EXPLAIN never executes the statement, so there is nothing different to
  // build for analyze. Declining that mode would disable the feature instead of
  // narrowing it - the direct Explain action always builds with mode "analyze"
  // (use-query-execution.ts:165) and refuses the run when the strategy returns null -
  // so both modes return the estimate, as the SQLite and Couchbase strategies do.
  buildSql(sql) {
    // ClickHouse's `EXPLAIN` describes without running, so a CTE is safe to explain.
    // The statement is read under this dialect's grammar all the same (#300): block
    // comments nest here, so a flat reading reports a keyword written inside one, and
    // an Explain built for a statement whose real keyword is a write is a dishonest
    // classification even where nothing executes.
    if (classifySelectPrefix(sql, CLICKHOUSE_GRAMMAR) === null) return null;
    // A trailing FORMAT would reformat the PLAN, not the statement's rows: live, a
    // wrapped `... FORMAT TSV` comes back as TSV text and the tree can never be
    // built. The clause describes the statement's own result, which an EXPLAIN never
    // produces, so dropping it is what makes the intent survive.
    // trimEnd because the tail above is a lookahead: whitespace that sat between the
    // format name and the end of the statement is not part of the match.
    return `EXPLAIN json = 1, indexes = 1 ${sql.replace(TRAILING_FORMAT, "").trimEnd()}`;
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
    const root = toPlanRoot(raw);
    if (!root) return null;
    return { kind: "tree", root: toTreeNode(root), raw };
  },
};
