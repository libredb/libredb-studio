/**
 * How an engine reaches the rows, read from an ESTIMATING plan (#330 T3).
 *
 * The query-optimization template's whole claim is that one statement reaches its
 * rows differently from another, so something has to say what "differently" means
 * without being either engine's dialect. This is that something: a small structural
 * reading, derived on the SERVER from a plan the run actually asked for, rather
 * than a description the model supplies about its own work.
 *
 * Three rules, each of which rules something out:
 *
 *  - **No engine text crosses into the summary.** A plan names tables and indexes,
 *    and those names are written by whoever can write to the database — untrusted
 *    input, exactly like a row value (`untrusted-content.ts`). So the summary is
 *    structural, and the statement the model wrote is what names the objects. It
 *    already knows what it asked about.
 *  - **Nothing is invented for an engine that does not report it.** SQLite's
 *    `EXPLAIN QUERY PLAN` carries no cost and no row estimate at all, so both are
 *    absent here. A zero would read as "free"; a guess would read as a measurement.
 *  - **An unverified dialect is `unknown`, not read by another engine's rule.**
 *    Phase 1 verified PostgreSQL and SQLite. Applying either rule to a third
 *    engine's grammar would be a claim about a plan nobody has looked at, and the
 *    same fail-closed argument `composed-sql.ts` makes for refusing to compose one.
 *
 * These are ESTIMATES throughout, and that is not a limitation to be worked around:
 * the executing form of EXPLAIN runs the statement, so it is default-denied
 * (`sqlExplainAnalyzeDescriptor`) and no tool reaches it. Whatever renders a
 * comparison owes the reader that sentence.
 */

import type { ExplainFormat } from "@/lib/db/types";

/** How the engine gets to the rows. Deliberately coarse — this is a comparison, not a plan viewer. */
export type AgentPlanAccess =
  /** At least one relation is read end to end, and none by an index. */
  | "full-scan"
  /** Every relation the plan names is reached through an index. */
  | "index"
  /** Both appear: an index on one side, a full read on another. */
  | "mixed"
  /** The plan says nothing this reading can interpret, or the dialect is unverified. */
  | "unknown";

export interface AgentPlanSummary {
  readonly access: AgentPlanAccess;
  /** The whole plan's estimate, when the engine reports one. Absent, never zero. */
  readonly estimatedRows?: number;
  readonly estimatedCost?: number;
}

/** What one node contributed: whether it scanned, and whether it used an index. */
interface AccessTally {
  scanned: boolean;
  indexed: boolean;
}

function accessOf(tally: AccessTally): AgentPlanAccess {
  if (tally.scanned && tally.indexed) return "mixed";
  if (tally.indexed) return "index";
  return tally.scanned ? "full-scan" : "unknown";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A number the engine reported, or nothing. `Number.isFinite` excludes NaN and Infinity alike. */
function reportedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────

/**
 * `EXPLAIN (FORMAT JSON)` answers one row, one column named `QUERY PLAN`, holding
 * an array whose first element carries the root `Plan`. The driver parses the JSON
 * itself, so this reads values rather than text.
 */
function postgresRoot(rows: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  const column = rows[0]?.["QUERY PLAN"];
  if (!Array.isArray(column)) return null;
  const first = column[0];
  if (!isRecord(first)) return null;
  const plan = first.Plan;
  return isRecord(plan) ? plan : null;
}

/** Node types that reach rows through an index, and the one that reads a relation whole. */
const PG_INDEX_NODE = /Index (Only )?Scan|Bitmap Index Scan/;
const PG_SCAN_NODE = /^(Seq Scan|Parallel Seq Scan)$/;

function tallyPostgres(node: Record<string, unknown>, tally: AccessTally): void {
  const nodeType = typeof node["Node Type"] === "string" ? node["Node Type"] : "";
  if (PG_INDEX_NODE.test(nodeType)) tally.indexed = true;
  else if (PG_SCAN_NODE.test(nodeType)) tally.scanned = true;
  const children = node.Plans;
  if (!Array.isArray(children)) return;
  for (const child of children) if (isRecord(child)) tallyPostgres(child, tally);
}

function summarisePostgres(rows: readonly Record<string, unknown>[]): AgentPlanSummary {
  const root = postgresRoot(rows);
  if (root === null) return { access: "unknown" };
  const tally: AccessTally = { scanned: false, indexed: false };
  tallyPostgres(root, tally);
  // The ROOT's estimates: they describe the whole plan, and a child's would describe
  // one step of it while reading as though it were the answer.
  const estimatedRows = reportedNumber(root["Plan Rows"]);
  const estimatedCost = reportedNumber(root["Total Cost"]);
  return {
    access: accessOf(tally),
    ...(estimatedRows === undefined ? {} : { estimatedRows }),
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
  };
}

// ─── SQLite ─────────────────────────────────────────────────────────────────

/**
 * `EXPLAIN QUERY PLAN` answers one row per step, and everything it says is in the
 * free-text `detail` column: `SCAN employee`, `SEARCH t USING INDEX ix (a=?)`,
 * `USE TEMP B-TREE FOR ORDER BY`. There is no cost and no row estimate anywhere in
 * it, which is why this returns neither.
 */
/**
 * `SEARCH` versus `SCAN` is the distinction, and matching on the word `INDEX` was
 * the wrong one — found by review on #344.
 *
 * SQLite reports several indexed seeks that never say "USING INDEX": a rowid lookup
 * (`SEARCH t USING INTEGER PRIMARY KEY`), a WITHOUT ROWID table's key
 * (`USING PRIMARY KEY`), and the transient index it builds for itself
 * (`USING AUTOMATIC COVERING INDEX`). Reading only `USING [COVERING] INDEX` filed
 * every one of them as `unknown` — the summary saying it could not tell, about a
 * plan that had said so plainly. `SEARCH` means a subset of rows was sought;
 * `SCAN` means a table was read whole. That is the engine's own vocabulary.
 */
const SQLITE_INDEX_STEP = /^SEARCH\b/;
const SQLITE_SCAN_STEP = /^SCAN\b/;

function summariseSqlite(rows: readonly Record<string, unknown>[]): AgentPlanSummary {
  const tally: AccessTally = { scanned: false, indexed: false };
  for (const row of rows) {
    const detail = typeof row.detail === "string" ? row.detail.trim() : "";
    if (SQLITE_INDEX_STEP.test(detail)) tally.indexed = true;
    else if (SQLITE_SCAN_STEP.test(detail)) tally.scanned = true;
  }
  return { access: accessOf(tally) };
}

// ─── the seam ───────────────────────────────────────────────────────────────

/**
 * Per-format readings, verified against that engine's grammar. A format with no
 * entry is `unknown` rather than read by a neighbour's rule.
 *
 * A partial record on purpose: `ExplainFormat` names six engines and Phase 1
 * verified two, so listing the other four as `unknown` would claim they had been
 * considered and found unreadable, when what is true is that nobody has looked.
 */
const PLAN_READINGS: Partial<Record<ExplainFormat, (rows: readonly Record<string, unknown>[]) => AgentPlanSummary>> = {
  "postgres-json": summarisePostgres,
  "sqlite-queryplan": summariseSqlite,
};

/**
 * Reads an estimating plan into the small structural summary a before/after
 * comparison is made of. Never throws: the upstream extractor is an unchecked cast,
 * so anything an engine or a driver produced has to arrive somewhere.
 */
export function summarisePlan(
  format: ExplainFormat | undefined,
  rows: readonly Record<string, unknown>[],
): AgentPlanSummary {
  const reading = format === undefined ? undefined : PLAN_READINGS[format];
  return reading === undefined ? { access: "unknown" } : reading(rows);
}
