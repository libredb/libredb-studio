/**
 * Canonical Phase 1 operation descriptors (#328, epic #325; extended by #330 T3,
 * B27 and #414).
 *
 * Seven operations exist: bounded read, plan inspection, plan execution, table
 * profiling, the curated operational reading, the provider's schema read and the
 * kubectl read. The set was pinned at THREE by epic #325 and reopened by #330 T3,
 * which is why the fourth carries that reversal in its own comment rather than
 * arriving as though the number had never been a decision; the fifth, sixth and
 * seventh carry their own reasons for the same reason. The fifth and sixth are the
 * ones that name no statement at all. The seventh is the bounded read for a
 * `kubernetes` connection: a statement the model wrote, in kubectl rather than SQL,
 * under its own id so the SQL contract stays what it was.
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
import { kubectlAgentReadInput } from "./kubectl-admission";
import { mongoAgentReadInput } from "./mongo-admission";

/** The selector of a scoped MongoDB catalog read: a kind, a database and a collection, any of them narrowed. */
export const mongoCatalogSelectorInput = z.strictObject({
  kind: z.enum(["columns", "indexes"]).default("columns"),
  schema: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
});

/** The selector of a MongoDB collection profile: the collection, and how deep to profile it. */
export const mongoProfileSelectorInput = z.strictObject({
  schema: z.string().min(1).optional(),
  table: z.string().min(1),
  depth: z.enum(["basic", "distribution", "pattern"]).default("basic"),
});

/**
 * A scoped MongoDB catalog read, on a `mongodb` connection: the provider's own inventory, narrowed by the selector the
 * model supplied.
 *
 * R0 `metadata-read`: the shape of the call bounds it. The selector reaches the provider's object-surface methods -
 * `listObjects` for a collection listing, `describeObject` for one collection's fields and indexes - and no value out
 * of any document is read, which is the same claim `db.schema.read` makes for the unscoped walk. Its own id so an
 * operator can deny the scoped catalog read without denying either the unscoped walk or the model's command reads.
 * No `RiskVerification`, like `db.schema.read`: R0 has no boundary to name beyond the shape of the call itself.
 */
export const mongoSchemaReadDescriptor: RegistrableOperationDescriptor = {
  id: "mongo.schema.read",
  riskClass: 0,
  accessLevel: "metadata-read",
  requiredCapabilities: [],
  resourceCost: "moderate",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: mongoCatalogSelectorInput,
};
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
  modelStatement: true,
  inputSchema: agentReadSqlInput,
  verification: {
    reviewedBy: "issue #328 acceptance bar (epic #325 product decisions)",
    boundary: BOUNDED_READ_BOUNDARY,
    verifiedOn: "2026-08-10",
  },
};

/**
 * Estimating plan inspection.
 *
 * It requires NO provider capability, and that is a correction rather than a
 * relaxation. `supportsExplain` is the EDITOR's capability: it is what decides
 * whether the Explain button and tab are rendered and which strategy module in
 * `src/lib/explain` reads the result. The agent's plan path does not go through
 * any of that. `composed-sql.ts` says so in its own header: the editor's PostgreSQL
 * strategy is deliberately not reused here, because it is chosen by a capability the
 * editor's provider measures and can emit the EXECUTING form. The agent composes its
 * own estimating form per dialect, and
 * `composeEstimatingExplain` REFUSES a dialect it has not verified
 * (`UNSUPPORTED_DIALECT`) before this descriptor is ever resolved, so the real gate
 * was never this line.
 *
 * Keeping it here denied the one engine where the two facts differ: SQL Server has a
 * verified estimating plan for the agent (`SET SHOWPLAN_ALL`, which the read-only
 * profile already compiles for every statement it admits) and no editor Explain, so
 * `supportsExplain` is honestly false while `inspect_plan` is honestly available.
 * Measured before the change: a `query-optimization` run on SQL Server had
 * `inspect_plan` denied `CAPABILITY_UNSUPPORTED` and finished `unanswered` with
 * `no-plan-evidence`: the workflow could not complete on that engine at all.
 *
 * `sqlExplainAnalyzeDescriptor` below keeps the requirement, and the asymmetry is the
 * point: the executing form is the editor's own statement, run on the editor's terms.
 */
export const sqlExplainEstimateDescriptor: RegistrableOperationDescriptor = {
  id: PLAN_INSPECTION_ID,
  riskClass: 0,
  accessLevel: "metadata-read",
  requiredCapabilities: [],
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
 * the backlog recorded profiling as deferred because of it; #330 T3
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
    reviewedBy: "issue #330 T3 (epic #325 product decision, reversing the monitoring-tools deferral)",
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
 * A FIFTH descriptor. The gap was an assessment that reported no monitor snapshot,
 * and what closing it needed was named there — "a metrics read needs a descriptor
 * shape for non-SQL reads" (#372). This is that shape: an input contract that carries
 * no statement at all.
 *
 * **R0/`metadata-read`, and that is a claim rather than a convenience.** R1 requires
 * a `RiskVerification` naming the mechanism that bounds the operation (the engine's
 * own read-only mechanism, or a Studio-enforced allowlist on the final request where
 * the engine has none), and a curated provider method has none to name: there is no
 * statement for a read-only transaction to bound. What bounds it instead is the
 * SHAPE of the call: the model supplies a kind out of a closed enum and two scalars,
 * the server chooses the method, and no model-authored text reaches an engine on this
 * path. The six readings are the engine's own operational views, which is metadata
 * about the server rather than the contents of user tables.
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

/**
 * The provider's own schema inspection: the reading the sidebar already performs.
 *
 * A SIXTH descriptor, and it exists because grounding had to reach engines for which
 * no catalog statement is composed (#414). Until then a run's inventory came only
 * from `sql.query.read` statements the server wrote per dialect, which is why the set
 * served two engines. This one names the other way the product already reads a
 * schema — the provider's OBJECT SURFACE, walked by `readObjectInventoryForGrounding`
 * — so that reading can be audited, budgeted and cited exactly like a statement instead
 * of happening beside the pipeline. It named `provider.getSchema()` until #789 deleted
 * that method, and the descriptor did not move: what it governs is "the product reads
 * this database's schema without composing a statement", which is the same operation an
 * operator means to allow or deny.
 *
 * **R0/`metadata-read`, on `db.operations.read`'s own argument.** R1 requires a
 * `RiskVerification` naming the mechanism that bounds the operation (see
 * `RiskVerification.boundary`), and a provider call has no statement for a read-only
 * transaction to bound. What bounds this one is the SHAPE of the call, and here that
 * shape is as narrow as it gets: the input is EMPTY, the server chooses the method,
 * and no model-authored text reaches an engine on this path at all.
 *
 * **`heavy`, unlike the curated reading it is modelled on**, and that is a cost claim
 * rather than caution. One charge buys a WALK, not a call: a `listContainers` per
 * container level, a `countObjects` per container, then a `listObjects` and a
 * `describeObjects` per container-and-kind pair, up to the pair bound. On a many-schema
 * database that is tens of round trips for one budgeted statement, and on the document
 * engines `describeObjects` reads a sample of documents. A one-container engine answers
 * it in a handful of catalog queries, but the cost is declared for the expensive shape
 * rather than the cheapest one: calling it `light` would tell the budget that the single
 * charge this path makes is always the cheap kind.
 *
 * The honest edge, stated rather than glossed, as `db.operations.read` states its
 * own: on the document engines the FIELD NAMES in the resulting inventory are
 * inferred from a sample of the user's own documents (MongoDB samples 100 per
 * collection; Couchbase's `INFER` does the same server-side). No value is kept — but
 * the existence of a field is DERIVED FROM DATA, which is a different claim from
 * "read out of a catalog", and this is the only agent reading of which that is true.
 * An operator who does not want it can deny this one operation id in the audit stream
 * without denying any other agent read — the same argument the table-profile and
 * curated-read descriptors make for having ids of their own.
 */
export const dbSchemaReadDescriptor: RegistrableOperationDescriptor = {
  id: "db.schema.read",
  riskClass: 0,
  accessLevel: "metadata-read",
  // None: `listContainers`, `countObjects`, `listObjects` and `describeObjects` are all
  // declared on the `DatabaseProvider` interface for every engine, so there is no
  // capability whose absence would make this call impossible. The one absence that does
  // exist is a DECLARATION rather than a capability - an engine declaring no
  // `objectKinds` has nothing to answer - and `readObjectInventoryForGrounding` answers
  // that before anything is acquired, charged or audited.
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  // Empty, and strict: the server chooses the containers and the kinds from the
  // provider's own declaration, so there is no selector to validate.
  // `z.strictObject({})` refuses every key rather than ignoring unknown
  // ones, so a caller that believes it can narrow this reading is told it cannot
  // instead of being handed the whole schema silently.
  inputSchema: z.strictObject({}),
};

const KUBECTL_READ_BOUNDARY =
  "Kubernetes: Studio's request allowlist (request-policy.ts) admits GET on discovery, on collections and objects " +
  "whose verbs discovery lists and on pod logs, and POST to the three self reviews, checked on the final method and " +
  "path before any socket; aggregated groups are read with GET semantics; the identity's RBAC decides what is " +
  "visible. The kubectl reader is not this boundary: it refuses writes, exec and tunnels so a model reads why.";

/**
 * One kubectl read the model wrote, on a `kubernetes` connection.
 *
 * R1 on a boundary the ENGINE does not provide: Kubernetes has no read-only transaction, so what bounds the read is
 * Studio's request allowlist on the final request and the identity's RBAC. The R1 contract admits that shape where
 * the engine has none (see `RiskVerification.boundary`). Its own id, and not a widened `sql.query.read`, so the SQL
 * contract and its audit action stay exactly what they were.
 */
export const kubectlQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "kubectl.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: kubectlAgentReadInput,
  verification: {
    reviewedBy: "Kubernetes agent execution design review",
    boundary: KUBECTL_READ_BOUNDARY,
    verifiedOn: "2026-10-14",
  },
};

const MONGO_READ_BOUNDARY =
  "MongoDB: the profiled connection is opened only after the server identifies itself as the measured engine " +
  "(buildInfo, fail-closed past FerretDB and the wire relatives) and after a negative write probe - an insert the server " +
  "must refuse with its authorization error - proves the principal cannot write, so no auth-off server and no " +
  "write-capable connection is admitted; the fence (mongo-admission.ts) admits the five read operations of the editor's " +
  "command envelope and refuses $out and $merge; the read itself carries maxTimeMS, the server's own deadline, and " +
  "caps find and aggregate one row past the budget server-side; a client-owned backstop ends a silent server; and the " +
  "assembled result is refused on the row budget's one-past signal and the byte budget.";

/**
 * One MongoDB command the model wrote, on a `mongodb` connection (issue #1614).
 *
 * R1 on a boundary the ENGINE provides in the direction that matters: MongoDB has no read-only transaction, so the
 * boundary is the principal's own inability to write, proven at the profiled connection's open by the server's
 * refusal of a probe write - which is why an auth-off server, where role restrictions are not enforced at all
 * (measured 2026-09-27), is refused outright rather than served. Its own id, and not a widened `sql.query.read`,
 * so the SQL contract and its audit action stay exactly what they were.
 */
export const mongoQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "mongo.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: mongoAgentReadInput,
  verification: {
    reviewedBy: "MongoDB agent execution design review",
    boundary: MONGO_READ_BOUNDARY,
    verifiedOn: "2026-10-15",
  },
};

const MONGO_PLAN_BOUNDARY =
  "MongoDB: the estimating plan runs under the same profiled connection and the same fence as mongo.query.read, with " +
  "the command wrapped in the explain command at queryPlanner verbosity - the engine PLANS and does not execute, so " +
  "no document is touched. `maxTimeMS` bounds the planning itself.";

/**
 * The estimating plan of one MongoDB command: `explain` at `queryPlanner` verbosity, which plans without executing.
 *
 * R1 for the same reason the SQL estimate is: the command text is model-written and reaches the engine, and the
 * answer is the engine's own account of how it would run it. Its own id rather than a widened `sql.explain.estimate`,
 * so the SQL contract and its audit action stay exactly what they were, and so the plan-reading surfaces can name the
 * estimating-plan operations of BOTH languages without a dialect comparison.
 */
export const mongoPlanEstimateDescriptor: RegistrableOperationDescriptor = {
  id: "mongo.plan.estimate",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "moderate",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: mongoAgentReadInput,
  verification: {
    reviewedBy: "MongoDB agent execution design review",
    boundary: MONGO_PLAN_BOUNDARY,
    verifiedOn: "2026-10-15",
  },
};

const MONGO_PROFILE_BOUNDARY =
  "MongoDB: the profile's aggregation is composed by the SERVER from the run's own captured inventory - the model " +
  "supplies only the collection and the depth - and it runs under the same profiled connection, fence and budgets as " +
  "mongo.query.read. Only counts come back: no value is read out of any field, which is what makes pointing a profile " +
  "at a collection of personal data acceptable at all.";

/**
 * One MongoDB collection profile, composed as an aggregation and run under the profile's bounds.
 *
 * R1 `data-read` on the same boundary the model's own command reads take. The composition is server-authored from
 * the captured inventory (`mongo-profile.ts`), so the input is the SELECTOR rather than a statement. Its own id for
 * the reason `sql.table.profile` has one: the counts are the one reading an operator may want to deny without
 * denying the reads the model itself writes.
 */
export const mongoTableProfileDescriptor: RegistrableOperationDescriptor = {
  id: "mongo.table.profile",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: mongoProfileSelectorInput,
  verification: {
    reviewedBy: "MongoDB agent execution design review",
    boundary: MONGO_PROFILE_BOUNDARY,
    verifiedOn: "2026-10-15",
  },
};

/** One namespace (a DNS-1123 label, as the API server names one) and an optional label selector over its pods. */
export const clusterUsageReadInput = z.strictObject({
  namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
  selector: z
    .string()
    .min(1)
    .max(1024)
    .refine((text) => text.trim() !== "", "a label selector may not be blank")
    .optional(),
});

/**
 * Container usage against requests and limits in one namespace, on a `kubernetes` connection: a curated reading the
 * agent takes instead of composing `kubectl top` and `kubectl get pods`.
 *
 * R1 `data-read`, not metadata: the selector is model-written and reaches the API server, and the answer is the
 * cluster's own usage data, so it sits under the same boundary as `kubectl.query.read`. `heavy` on the
 * `db.schema.read` precedent: one charge buys a reading of several lists (PodMetrics, pods, ReplicaSets, Jobs). It has
 * its own ceiling of 500 rows, and a reading past it is refused rather than truncated.
 */
export const clusterUsageReadDescriptor: RegistrableOperationDescriptor = {
  id: "cluster.usage.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: clusterUsageReadInput,
  verification: {
    reviewedBy: "Kubernetes agent execution design review",
    boundary: KUBECTL_READ_BOUNDARY,
    verifiedOn: "2026-10-14",
  },
};

/** One namespace (a DNS-1123 label, as the API server names one) and nothing to narrow it: a profile is all of it. */
export const clusterWorkloadsReadInput = z.strictObject({
  namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
});

/**
 * The workload profile of one namespace, on a `kubernetes` connection: a curated reading the agent's cluster health
 * workflow takes instead of composing `kubectl get` over each controller kind, the pods and the Warning events.
 *
 * R1 `data-read` under the same boundary as `kubectl.query.read`, for the reason `cluster.usage.read` is: the
 * namespace is model-written and reaches the API server, and the answer is the cluster's own state. `heavy` because
 * one charge buys eight lists. Its own ceiling of 500 workloads, and a reading past it is refused rather than
 * truncated.
 */
export const clusterWorkloadsReadDescriptor: RegistrableOperationDescriptor = {
  id: "cluster.workloads.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: clusterWorkloadsReadInput,
  verification: {
    reviewedBy: "Kubernetes agent execution design review",
    boundary: KUBECTL_READ_BOUNDARY,
    verifiedOn: "2026-10-14",
  },
};

const CANONICAL_DESCRIPTORS: readonly RegistrableOperationDescriptor[] = Object.freeze([
  sqlQueryReadDescriptor,
  sqlExplainEstimateDescriptor,
  sqlExplainAnalyzeDescriptor,
  sqlTableProfileDescriptor,
  dbOperationsReadDescriptor,
  dbSchemaReadDescriptor,
  kubectlQueryReadDescriptor,
  clusterUsageReadDescriptor,
  clusterWorkloadsReadDescriptor,
  mongoQueryReadDescriptor,
  mongoSchemaReadDescriptor,
  mongoPlanEstimateDescriptor,
  mongoTableProfileDescriptor,
]);

/**
 * Whether an operation is a bounded read of a statement the model wrote: data-read, carrying a model statement, and
 * never approval-gated. Derived from the registered descriptors rather than a list of ids, so a later language's
 * read is one by declaring it.
 */
export function isStatementReadOperation(id: string): boolean {
  return CANONICAL_DESCRIPTORS.some(
    (descriptor) =>
      descriptor.id === id &&
      descriptor.accessLevel === "data-read" &&
      descriptor.modelStatement === true &&
      !descriptor.requiresApproval,
  );
}

export function createCanonicalOperationRegistry(): OperationRegistry {
  const registry = new OperationRegistry();
  for (const descriptor of CANONICAL_DESCRIPTORS) registry.register(descriptor);
  return registry;
}
