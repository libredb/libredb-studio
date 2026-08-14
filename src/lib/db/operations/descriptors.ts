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

import { z } from "zod";
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

/**
 * Which operational reading a curated call asks for.
 *
 * Named after what a DBA asks about rather than after the provider method that
 * answers, because the method is an implementation this layer may re-route and the
 * question is not. Every member maps onto a method the `DatabaseProvider` interface
 * declares for EVERY engine (`src/lib/db/types.ts`), which is the whole reason this
 * operation can be offered where `sql.query.read` cannot.
 */
export const CURATED_OPERATION_KINDS = [
  "sessions",
  "slow-queries",
  "table-stats",
  "index-stats",
  "storage",
  "health",
] as const;

export type CuratedOperationKind = (typeof CURATED_OPERATION_KINDS)[number];

/**
 * The input contract for a curated operational read.
 *
 * It cannot reuse `agentReadSqlInput`: there is no statement. A curated call names a
 * READING, and the server decides which provider method answers it — so the thing
 * validated here is the question, not a statement somebody could smuggle a side
 * effect into. `kind` is REQUIRED, unlike `inspect_schema`'s optional selector: that
 * field's absent case means "the inventory a bare inspection always meant", and this
 * operation has no history for an absent value to mean.
 *
 * Exported so the agent tool declares the SAME schema the descriptor validates
 * against. Two schemas for one contract is two things to keep equal, and the one
 * that drifted would be the one a model was refused by after being told otherwise.
 */
export const agentCuratedReadInput = z.strictObject({
  kind: z.enum(CURATED_OPERATION_KINDS),
  /** How many rows the reading may return. Passed to the engine where its method takes one, and applied to the rows either way. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Narrows the table and index readings; ignored by the readings that have no schema dimension. */
  schema: z.string().min(1).optional(),
});

export type AgentCuratedReadInput = z.infer<typeof agentCuratedReadInput>;

const CURATED_OPERATION_READ_ID = "db.operations.read";

/**
 * The curated operational read: what the engine says about ITSELF.
 *
 * A FIFTH descriptor, and the one `docs/BACKLOG.md` B27 said would need its own
 * shape — "a metrics read needs a descriptor shape for non-SQL reads". This is that
 * shape: an input contract that carries no statement at all.
 *
 * **R0/`metadata-read`, and that is a claim rather than a convenience.** R1 requires
 * a `RiskVerification` naming the database-native mechanism that bounds the
 * operation, and a curated provider method has none to name — there is no statement
 * for a read-only transaction to bound. What bounds it instead is the SHAPE of the
 * call: the model supplies a kind out of a closed enum and two scalars, the server
 * chooses the method, and no model-authored text reaches an engine on this path. The
 * six readings are the engine's own operational views, which is metadata about the
 * server rather than the contents of user tables.
 *
 * The honest edge, stated rather than glossed: two of the readings carry TEXT that a
 * user wrote. `SlowQueryStats.query` and `ActiveSessionDetails.query` are statements,
 * and a statement can have literal values in it; `ActiveSessionDetails.user` is an
 * identity. That is inherent to the question "which queries are slow" and cannot be
 * redacted without answering a different question, so it is declared here and in
 * `docs/AGENT.md` instead. An operator who does not want it can deny this one
 * operation id in the audit stream without denying any other agent read — which is
 * the same argument the table-profile descriptor makes for having its own id.
 */
export const dbOperationsReadDescriptor: RegistrableOperationDescriptor = {
  id: CURATED_OPERATION_READ_ID,
  riskClass: 0,
  accessLevel: "metadata-read",
  requiredCapabilities: [],
  // Light in the sense the budget means it: one provider call, no statement the
  // engine has to plan. It is NOT free — `getActiveSessions` reads a live view — and
  // the row cap is applied by the projection, because these methods take no budget.
  resourceCost: "light",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: agentCuratedReadInput,
};

export function createCanonicalOperationRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registry.register(sqlQueryReadDescriptor);
  registry.register(sqlExplainEstimateDescriptor);
  registry.register(sqlExplainAnalyzeDescriptor);
  registry.register(sqlTableProfileDescriptor);
  registry.register(dbOperationsReadDescriptor);
  return registry;
}
