/**
 * Canonical Phase 1 operation descriptors (#328, epic #325).
 *
 * Exactly three operations exist: bounded read, plan inspection, plan
 * execution. Plan inspection and plan execution are DISTINCT descriptors whose
 * ids are derived from the explain seam's modes (`ExplainMode`,
 * src/lib/explain) — renaming a mode breaks these ids at compile time — and
 * the executing variant is default-denied because EXPLAIN ANALYZE runs the
 * statement (epic #325 product decision).
 */

import { z } from "zod";
import type { ExplainMode } from "@/lib/explain";
import { OperationRegistry } from "./registry";
import type { RegistrableOperationDescriptor } from "./types";

/**
 * Exactly one SQL statement string; unknown keys are rejected (fail closed).
 * Single-statement and read-only guarantees come from the database-native
 * execution profiles, not from this schema.
 */
const sqlStatementInput = z.strictObject({ sql: z.string().min(1) });

type ExplainOperationId = `sql.explain.${ExplainMode}`;
const PLAN_INSPECTION_ID: ExplainOperationId = "sql.explain.estimate";
const PLAN_EXECUTION_ID: ExplainOperationId = "sql.explain.analyze";

/**
 * Verification markers cite the boundary pinned by issue #328 / epic #325 and
 * implemented by this milestone's execution profiles: the database engine, not
 * a parser, rejects anything but a bounded read through the agent path.
 */
const BOUNDED_READ_BOUNDARY =
  "PostgreSQL: single statement inside BEGIN READ ONLY with transaction-local timeout, rolled back and released; " +
  "SQLite: separate read-only open (no file creation) with PRAGMA query_only verified at open";

export const sqlQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "sql.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: sqlStatementInput,
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
  inputSchema: sqlStatementInput,
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
  inputSchema: sqlStatementInput,
  verification: {
    reviewedBy: "issue #328 acceptance bar (epic #325 product decisions)",
    boundary: `Plan execution runs under the same database-native profile as bounded reads: ${BOUNDED_READ_BOUNDARY}`,
    verifiedOn: "2026-08-10",
  },
};

export function createCanonicalOperationRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  registry.register(sqlQueryReadDescriptor);
  registry.register(sqlExplainEstimateDescriptor);
  registry.register(sqlExplainAnalyzeDescriptor);
  return registry;
}
