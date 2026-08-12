/**
 * Canonical Phase 1 operation descriptors (#328, epic #325; extended by #330 T3).
 *
 * Four operations exist: bounded read, plan inspection, plan execution and table
 * profiling. The set was pinned at THREE by epic #325 and reopened by #330 T3,
 * which is why the fourth carries that reversal in its own comment rather than
 * arriving as though the number had never been a decision.
 *
 * Plan inspection and plan execution are DISTINCT descriptors whose
 * ids are derived from the explain seam's modes (`ExplainMode`,
 * src/lib/explain) — renaming a mode breaks these ids at compile time — and
 * the executing variant is default-denied because EXPLAIN ANALYZE runs the
 * statement (epic #325 product decision).
 */

import type { ExplainMode } from "@/lib/explain";
import { OperationRegistry } from "./registry";
import { agentPlanExecutionSqlInput, agentReadSqlInput } from "./statement-guard";
import type { RegistrableOperationDescriptor } from "./types";

type ExplainOperationId = `sql.explain.${ExplainMode}`;
const PLAN_INSPECTION_ID: ExplainOperationId = "sql.explain.estimate";
const PLAN_EXECUTION_ID: ExplainOperationId = "sql.explain.analyze";

/**
 * Verification markers cite the boundary pinned by issue #328 / epic #325 and
 * implemented by this milestone's execution profiles: the database engine, not
 * a parser, rejects anything but a bounded read through the agent path.
 */
const BOUNDED_READ_BOUNDARY =
  "PostgreSQL: single statement inside BEGIN READ ONLY with transaction-local timeout, rolled back and released, " +
  "as a least-privilege role verified at open — the transaction alone does not stop server-side file access or " +
  "program execution (COPY TO PROGRAM), only the role does; " +
  "SQLite: separate read-only open governing the target file (no file creation), plus PRAGMA query_only " +
  "re-asserted and verified before every statement to refuse writes to other files (VACUUM INTO)";

export const sqlQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "sql.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: agentReadSqlInput,
  verification: {
    reviewedBy: "issue #328 acceptance bar (epic #325 product decisions)",
    boundary: BOUNDED_READ_BOUNDARY,
    verifiedOn: "2026-08-10",
  },
};

export const sqlExplainEstimateDescriptor: RegistrableOperationDescriptor = {
  id: PLAN_INSPECTION_ID,
  riskClass: 0,
  accessLevel: "metadata-read",
  requiredCapabilities: ["supportsExplain"],
  resourceCost: "light",
  supportsDryRun: false,
  requiresApproval: false,
  // The inspecting variant takes the read schema, so `EXPLAIN ANALYZE` smuggled
  // into a plan-inspection request is refused at the input stage rather than
  // becoming a plan execution that never asked for approval.
  inputSchema: agentReadSqlInput,
};

export const sqlExplainAnalyzeDescriptor: RegistrableOperationDescriptor = {
  id: PLAN_EXECUTION_ID,
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: ["supportsExplain"],
  resourceCost: "heavy",
  supportsDryRun: false,
  // Default-denied: EXPLAIN ANALYZE executes the statement, so it can only
  // ever reach require-approval, never a plain allow (epic #325).
  requiresApproval: true,
  inputSchema: agentPlanExecutionSqlInput,
  verification: {
    reviewedBy: "issue #328 acceptance bar (epic #325 product decisions)",
    boundary: `Plan execution runs under the same database-native profile as bounded reads: ${BOUNDED_READ_BOUNDARY}`,
    verifiedOn: "2026-08-10",
  },
};

/**
 * Per-table profiling: a bounded read whose aggregates the server composes.
 *
 * A FOURTH descriptor, and that is a reversal of a product decision rather than an
 * oversight being corrected. Epic #325 pinned the canonical set at three, and
 * `docs/BACKLOG.md` B17 recorded profiling as deferred because of it; #330 T3
 * instructs that profiling reach the database "as new descriptors in
 * `descriptors.ts` at R0/R1", which is the owner reopening that decision.
 *
 * Why it is not simply `sql.query.read`, which it structurally resembles: a profile
 * aggregates over a whole table by design, and it is the one agent read aimed at
 * columns a deployment may consider personal. Its own id is what lets an operator
 * see profiling in the audit stream, and deny it, without also denying every read
 * the agent makes. The statement is still bounded by the same guard — this widens
 * what can be NAMED, never what can be run.
 */
export const sqlTableProfileDescriptor: RegistrableOperationDescriptor = {
  id: "sql.table.profile",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  // The same input contract as any bounded read: the composed aggregate has to
  // satisfy the statement guard exactly as a model-drafted read does.
  inputSchema: agentReadSqlInput,
  verification: {
    reviewedBy: "issue #330 T3 (epic #325 product decision, reversing docs/BACKLOG.md B17)",
    boundary: BOUNDED_READ_BOUNDARY,
    verifiedOn: "2026-08-12",
  },
};

export function createCanonicalOperationRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registry.register(sqlQueryReadDescriptor);
  registry.register(sqlExplainEstimateDescriptor);
  registry.register(sqlExplainAnalyzeDescriptor);
  registry.register(sqlTableProfileDescriptor);
  return registry;
}
