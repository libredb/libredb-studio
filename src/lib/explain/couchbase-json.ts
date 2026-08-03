import type { ExplainStrategy, ExplainTreeNode } from "./types";

const SELECT_ONLY = /^\s*SELECT\b/i;

/** How many wrapper layers ({ plan }, row arrays) toPlanRoot peels before giving up. */
const MAX_UNWRAP_DEPTH = 4;

/** Keys whose values compose the qualified keyspace path, in path order. */
const KEYSPACE_PATH_KEYS = ["bucket", "scope", "keyspace"] as const;

/**
 * A node of a Couchbase EXPLAIN plan. "#operator" is the discriminator; child
 * operators hang off tilde-prefixed keys — "~children" (array) on Sequence and
 * friends, "~child" (single operator) on Parallel — so both forms are walked.
 */
interface CouchbaseOperator {
  "#operator": string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperator(value: unknown): value is CouchbaseOperator {
  return isRecord(value) && typeof value["#operator"] === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Couchbase writes -1 where the optimizer produced no estimate; that is not a metric. */
function isEstimate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Accepts the plan itself, the EXPLAIN row ({ plan }) and the row array, in any nesting up to MAX_UNWRAP_DEPTH. */
function toPlanRoot(raw: unknown): CouchbaseOperator | null {
  let current = raw;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (isOperator(current)) return current;
    if (Array.isArray(current)) {
      current = current[0];
    } else if (isRecord(current) && "plan" in current) {
      current = current.plan;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Enterprise's cost-based optimizer reports estimates either flat on the operator
 * or grouped under "optimizer_estimates", depending on server version.
 */
function readEstimate(op: CouchbaseOperator, key: "cost" | "cardinality"): number | undefined {
  const flat = op[key];
  if (isEstimate(flat)) return flat;
  const grouped = op.optimizer_estimates;
  if (!isRecord(grouped)) return undefined;
  const nested = grouped[key];
  return isEstimate(nested) ? nested : undefined;
}

function buildMetrics(op: CouchbaseOperator): ExplainTreeNode["metrics"] {
  const estCost = readEstimate(op, "cost");
  const estRows = readEstimate(op, "cardinality");
  if (estCost === undefined && estRows === undefined) return undefined;
  const metrics: NonNullable<ExplainTreeNode["metrics"]> = {};
  if (estCost !== undefined) metrics.estCost = estCost;
  if (estRows !== undefined) metrics.estRows = estRows;
  return metrics;
}

function buildDetail(op: CouchbaseOperator): string | undefined {
  const parts: string[] = [];
  const keyspacePath = KEYSPACE_PATH_KEYS.map((key) => op[key])
    .filter(isNonEmptyString)
    .join(".");
  if (keyspacePath.length > 0) parts.push(keyspacePath);
  if (isNonEmptyString(op.index)) parts.push(`index: ${op.index}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function collectChildren(op: CouchbaseOperator): CouchbaseOperator[] {
  const children: CouchbaseOperator[] = [];
  for (const [key, value] of Object.entries(op)) {
    if (!key.startsWith("~")) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isOperator(item)) children.push(item);
      }
    } else if (isOperator(value)) {
      children.push(value);
    }
  }
  return children;
}

function toTreeNode(op: CouchbaseOperator): ExplainTreeNode {
  const node: ExplainTreeNode = { label: op["#operator"], children: collectChildren(op).map(toTreeNode) };
  const detail = buildDetail(op);
  if (detail !== undefined) node.detail = detail;
  const metrics = buildMetrics(op);
  if (metrics !== undefined) node.metrics = metrics;
  return node;
}

export const couchbaseJsonStrategy: ExplainStrategy = {
  format: "couchbase-json",
  // EXPLAIN produces the plan without executing the statement. SQL++ has no
  // EXPLAIN ANALYZE - real timings come only from the request-level profile
  // parameter, which ExplainStrategy cannot set because it emits SQL only - so
  // both modes return the estimate, exactly as the SQLite strategy does for
  // EXPLAIN QUERY PLAN. Declining analyze instead would disable the feature
  // entirely rather than narrow it: the direct Explain action always builds with
  // mode "analyze" (use-query-execution.ts:165) and refuses the run when the
  // strategy returns null.
  buildSql(sql) {
    if (!SELECT_ONLY.test(sql.trim())) return null;
    return `EXPLAIN ${sql}`;
  },
  extractPlan(result) {
    const plan = result.rows?.[0]?.plan;
    return plan === undefined ? result.rows : plan;
  },
  toRenderModel(raw) {
    const root = toPlanRoot(raw);
    if (!root) return null;
    return { kind: "tree", root: toTreeNode(root), raw };
  },
};
