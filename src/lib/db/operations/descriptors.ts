/**
 * Canonical Phase 1 operation descriptors (#328, epic #325; extended by #330 T3,
 * B27 and #414).
 *
 * Every operation is a read: the bounded read, plan inspection, plan execution and
 * table profiling on SQL; the curated operational reading and the provider's schema
 * read, which name no statement at all; the kubectl read and the two curated
 * cluster readings on Kubernetes; and the command read, the scoped catalog, the
 * estimating plan and the composed profile on MongoDB. The set was pinned at THREE
 * by epic #325 and reopened by #330 T3, which is why the profile carries that
 * reversal in its own comment rather than arriving as though the number had never
 * been a decision, and every operation added since carries its own reason the same
 * way. A language's statement read has an id of its own, so the SQL contract stays
 * what it was.
 *
 * Plan inspection and plan execution are DISTINCT descriptors whose
 * ids are derived from the explain seam's modes (`ExplainMode`,
 * src/lib/explain) — renaming a mode breaks these ids at compile time — and
 * the executing variant is default-denied because EXPLAIN ANALYZE runs the
 * statement (epic #325 product decision).
 */

import { z } from "zod";
import type { ExplainMode } from "@/lib/explain";
import { readMongoCommand } from "@/lib/db/providers/document/mongodb/envelope";
import { OperationRegistry } from "./registry";
import { cypherAgentReadInput } from "./cypher-admission";
import { influxqlAgentReadInput } from "./influxql-admission";
import { kubectlAgentReadInput } from "./kubectl-admission";
import { libredbkvAgentReadInput } from "./libredbkv-admission";
import { milvusrpcAgentReadInput } from "./milvusrpc-admission";
import { mongoAgentReadInput } from "./mongo-admission";
import { qdrantapiAgentReadInput } from "./qdrantapi-admission";
import { rediscliAgentReadInput } from "./rediscli-admission";
import { weaviateapiAgentReadInput } from "./weaviateapi-admission";
import { agentPlanExecutionSqlInput, agentQueryReadSqlInput, agentReadSqlInput } from "./statement-guard";
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
  // The read input, plus the admission only a composed catalog read carries (`admitComposedStatement`).
  inputSchema: agentQueryReadSqlInput,
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
  "MongoDB: the profiled connection opens only after the server identifies itself as the measured engine " +
  "(buildInfo, fail-closed past FerretDB and the other wire relatives), after the session's own privileges read as " +
  "reads on the connection's database alone against a fail-closed action allowlist, and after the server refuses a " +
  "delete that matches nothing, which changes nothing either way; a server that accepts it enforces no authorization " +
  "and is refused. The command reader (envelope.ts) admits the five reads of the editor's command envelope with read " +
  "pipeline stages only and refuses server-side JavaScript; a command naming a database other than the connection's " +
  "is refused; every command carries maxTimeMS, and Studio kills the session when the server overruns it; find and " +
  "aggregate are capped one document past the row budget server-side; a cursor's documents are counted in BSON " +
  "bytes before they are decoded, while a distinct's one reply, which the server holds to 16 MiB, is decoded whole " +
  "before its values are counted; and a result past either budget is refused, never truncated.";

/**
 * One MongoDB command the model wrote, on a `mongodb` connection (issue #1614).
 *
 * R1 on a boundary the ENGINE provides in the direction that matters: MongoDB has no read-only transaction, so the
 * boundary is the principal's own inability to write, proven at the profiled connection's open by its privileges,
 * read against a read-only allowlist, and by the server's refusal of a probe - which is why an auth-off server, where
 * role restrictions are not enforced at all (measured 2026-09-27), is refused outright rather than served. Its own
 * id, and not a widened `sql.query.read`, so the SQL contract and its audit action stay exactly what they were.
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
    verifiedOn: "2026-10-17",
  },
};

const LIBREDBKV_READ_BOUNDARY =
  "LibreDB: each statement opens the store file on a handle of its own through Studio's read-only file adapter " +
  "(libredb-read-only-file.ts), closed after it: the descriptor is opened for reading only and a missing file is " +
  "refused rather than created, the one call the engine writes through (the write-ahead log's append) refuses before " +
  "any write, and truncate and fsync change nothing, so no call on the handle can change the file; it takes no writer " +
  "lock, so it opens beside the editor's writer and reads what that writer has committed. The command reader admits " +
  "get, prefix and range on one line and refuses put and delete by name before the file is opened; a result past the " +
  "row or byte budget is refused, never truncated.";

/**
 * One LibreDB read command the model wrote, on a `libredb` connection.
 *
 * R1 on a boundary the engine's own file seam provides: LibreDB has no read-only mode of its own and no principal, so
 * what bounds the read is the handle, opened through a filesystem that cannot write. Its own id, and not a widened
 * `sql.query.read`, so the SQL contract and its audit action stay exactly what they were.
 */
const libredbkvQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "libredbkv.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: libredbkvAgentReadInput,
  verification: {
    reviewedBy: "LibreDB agent execution design review",
    boundary: LIBREDBKV_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

const INFLUXQL_READ_BOUNDARY =
  "InfluxDB (InfluxQL, 1.x and 2.x): before the open and before every statement, on the requests of that statement's " +
  "call, the server proves the connection's principal reads only (influxql-agent-read.ts): a 1.x user must be refused " +
  "SHOW USERS as needing the admin privilege, a 2.x token must list no system bucket, and every database the principal " +
  "lists must refuse a no-op DELETE, so an admin, a server with authentication off and a principal that can write any " +
  "database it lists, where SELECT ... INTO would land, are refused, and InfluxDB 3 is refused on this path. The " +
  "statement reader admits one SELECT, SHOW of the catalog or EXPLAIN of a SELECT with no comment and no carriage " +
  "return, refusing INTO, every write and SHOW QUERIES before anything is sent; the statement is sent with the " +
  "connection's database and nothing else the caller chose, and a result past the row or byte budget is refused, never " +
  "truncated.";

/**
 * One InfluxQL read statement the model wrote, on an `influxdb` connection.
 *
 * R1 on a boundary the server's own authorization provides: the v1 `/query` route runs any statement the principal may
 * run, so what bounds the read is a principal the server proves cannot write. Its own id, and not a widened
 * `sql.query.read`, so the SQL contract and its audit action stay exactly what they were.
 */
const influxqlQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "influxql.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: influxqlAgentReadInput,
  verification: {
    reviewedBy: "InfluxDB agent execution design review",
    boundary: INFLUXQL_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

const WEAVIATEAPI_READ_BOUNDARY =
  "Weaviate: the provider's closed table of 20 GET and POST operations, which can name no write, of which an agent " +
  "request reaches the meta, schema, shard, tenant, alias and node reads and an aggregate count only, every body key " +
  "closed (metadata-request.ts). Before the open and before every request, under that request's deadline, the server " +
  "proves the key a viewer (metadata-read.ts): GET /v1/users/own-info must name at least one role and every action must " +
  "be one of the viewer role's twelve read actions, so a connection with no key, an admin key, a role that writes and " +
  "a server with RBAC off are refused. A request naming a tenant reads the tenant's own record first and is refused " +
  "unless it is HOT, and a shard read or count of a multi-tenant collection naming no tenant is refused, since a " +
  "shard read naming none wakes them; object reads, searches, GraphQL, every module call, filters and " +
  "groupBy are refused before anything is sent. Every answer is projected to names, counts and flags " +
  "(metadata-only.ts), and a result past the row or byte budget is refused, never truncated.";

/**
 * One Weaviate metadata read the model wrote, on a `weaviate` connection.
 *
 * R1 on a structural boundary: the client can build no write, and the server proves the key a viewer before every
 * request. Its own id, and not a widened `sql.query.read`, so the SQL contract and its audit action stay exactly what
 * they were.
 */
const weaviateapiQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "weaviateapi.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: weaviateapiAgentReadInput,
  verification: {
    reviewedBy: "Weaviate agent execution design review",
    boundary: WEAVIATEAPI_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

const QDRANTAPI_READ_BOUNDARY =
  "Qdrant: the provider's closed table of 17 GET and POST read routes, which can name no write, of which an agent " +
  "request reaches the version, collection list, collection, exists, alias, count and cluster reads only, every body " +
  "key closed and a count taking exact alone (metadata-request.ts). Before the open and before every request, under " +
  "that request's deadline, the server proves the key reads only (metadata-read.ts): it must refuse 403 an alias " +
  "update with no action and a point delete of no point on every collection the key lists, at most 32, so a " +
  "connection with no key, the API key, a JWT that manages or writes any collection and a server with no key " +
  "configured are refused. Point reads, scrolls, facets, every query, and so every inference call, the optimization " +
  "and snapshot lists and every write are refused before anything is sent. Every answer is projected to names, " +
  "counts and flags (metadata-only.ts), and a result past the row or byte budget is refused, never truncated.";

/**
 * One Qdrant metadata read the model wrote, on a `qdrant` connection.
 *
 * R1 on a structural boundary: the client can build no write a console request names, and the server proves the key
 * read-only before every request. Its own id, and not a widened `sql.query.read`, so the SQL contract and its audit
 * action stay exactly what they were.
 */
const qdrantapiQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "qdrantapi.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: qdrantapiAgentReadInput,
  verification: {
    reviewedBy: "Qdrant agent execution design review",
    boundary: QDRANTAPI_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

const CYPHER_READ_BOUNDARY =
  "Neo4j Enterprise Edition: before the open and before every statement, under that statement's deadline, the server " +
  "proves the connection's user reads only (agent-boundary.ts): Enterprise Edition at a version whose built-in " +
  "procedures and functions are pinned, every granted privilege of every role a read, no LOAD that a DENY LOAD ON ALL " +
  "DATA does not override, and no executable procedure or function outside the built-ins, so an administrator, a user " +
  "that writes or loads, a server with an extension the user can run and Community Edition are refused. The statement " +
  "reader admits one statement under the editor's read policy with no comment and no carriage return, refusing every " +
  "write, LOAD CSV, USE and any other procedure before anything is sent; the server's EXPLAIN classification runs before " +
  "it, it runs in a READ session on the connection's database, and a result past the row or byte budget is refused, " +
  "never truncated.";

/**
 * One Cypher read statement the model wrote, on a `neo4j` connection.
 *
 * R1 on a boundary the server's own authorization provides: a READ session still runs LOAD CSV and any procedure an
 * extension adds, so what bounds the read is a user the server proves cannot write, load or run an extension. Its own
 * id, and not a widened `sql.query.read`, so the SQL contract and its audit action stay exactly what they were.
 */
const cypherQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "cypher.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: cypherAgentReadInput,
  verification: {
    reviewedBy: "Neo4j agent execution design review",
    boundary: CYPHER_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

const MILVUSRPC_READ_BOUNDARY =
  "Milvus: the provider's gRPC stub filtered to a closed table of RPCs, whose only writes are Load and Release, which " +
  "the admin's maintenance route alone sends; an agent request reaches the database, collection, schema, statistics, " +
  "load state, partition, index and alias reads only, in the console's grammar with every body key closed and the " +
  "connection's own database on every call (metadata-request.ts). Before the open and before every request, under " +
  "that request's deadline, the server proves the user reads only (read-only-proof.ts): it must refuse the user " +
  "PERMISSION_DENIED the list of users, and every privilege its roles and public grant must be a read, so a connection " +
  "naming no user, root, the admin role, a role that writes, loads or releases, an unknown privilege group and a " +
  "server with authorization off are refused. Queries, gets and searches, and so every function a search runs on the " +
  "server, are refused before anything is sent. Every answer is projected to names, counts and flags " +
  "(metadata-only.ts), and a result past the row or byte budget is refused, never truncated.";

/**
 * One Milvus metadata read the model wrote, on a `milvus` connection.
 *
 * R1 on a structural boundary: the stub can name no write an agent request reaches, and the server proves the user
 * read-only before every request. Its own id, and not a widened `sql.query.read`, so the SQL contract and its audit
 * action stay exactly what they were.
 */
const milvusrpcQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "milvusrpc.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: milvusrpcAgentReadInput,
  verification: {
    reviewedBy: "Milvus agent execution design review",
    boundary: MILVUSRPC_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

const REDISCLI_READ_BOUNDARY =
  "Redis: the provider's closed table of metadata reads, each flagged readonly by the server's own COMMAND INFO and " +
  "none flagged write, admin, pubsub, may_replicate or script_runner, in no write, admin, dangerous, scripting or " +
  "pubsub category, and with only read-only key specs (redis-agent-statement.ts): DBSIZE, and for one key the command " +
  "names TYPE, EXISTS, TTL, PTTL, STRLEN, LLEN, HLEN, SCARD, ZCARD, XLEN, OBJECT ENCODING and MEMORY USAGE, read " +
  "from one line into the exact argv sent. Every command runs on a connection of its own in the connection's " +
  "database, closed after it, and before it, on that connection, the server proves the ACL user reads only " +
  "(redis-read-only-proof.ts): HELLO must answer the measured Redis or Valkey shape in standalone mode, and the " +
  "user must be refused write, admin, dangerous, scripting and pubsub probes that change nothing even when " +
  "admitted, each as a command it does not hold, so a connection naming no user, the default user and a user " +
  "holding any probed command, even on its own key pattern only, are refused; a write the probes leave out is " +
  "stopped by the table, which sends none. Key names and stored values " +
  "are withheld: nothing lists keys or reads a value, field or member, every answer is projected to counts, types and " +
  "sizes (redis-metadata-read.ts), a server error is worded by its code alone, and a result past the row or byte " +
  "budget is refused, never truncated.";

/**
 * One Redis metadata read the model wrote, on a `redis` connection.
 *
 * R1 on a structural boundary: the table can name no write and no read of a key name or value, and the server proves
 * the ACL user read-only before every command. Its own id, and not a widened `sql.query.read`, so the SQL contract and
 * its audit action stay exactly what they were.
 */
const rediscliQueryReadDescriptor: RegistrableOperationDescriptor = {
  id: "rediscli.query.read",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  modelStatement: true,
  inputSchema: rediscliAgentReadInput,
  verification: {
    reviewedBy: "Redis agent execution design review",
    boundary: REDISCLI_READ_BOUNDARY,
    verifiedOn: "2026-10-30",
  },
};

/** The selector of a scoped MongoDB catalog read: a kind, a database and a collection, any of them narrowed. */
const mongoCatalogSelectorInput = z.strictObject({
  kind: z.enum(["columns", "indexes"]).default("columns"),
  schema: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
});

/**
 * A scoped MongoDB catalog read, on a `mongodb` connection: the provider's own catalog, narrowed by the selector the
 * model supplied.
 *
 * R0 `metadata-read`: the shape of the call bounds it. The selector reaches the provider's catalog read for the agent
 * (`readCatalogReadOnly`) - a collection listing, or one collection's fields and indexes - and no value out of any
 * document is returned, which is the same claim `db.schema.read` makes for the unscoped walk. Its own id so an
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

const MONGO_PLAN_BOUNDARY =
  "MongoDB: the estimating plan runs under the same profiled connection, reader and bound database as " +
  "mongo.query.read, built by the same builder: the command wrapped in explain at queryPlanner verbosity, which " +
  "answers with the plan and none of the command's documents; with several candidate plans the server runs each for " +
  "a bounded trial, under the same maxTimeMS and kill.";

/**
 * The estimating plan of one MongoDB command: `explain` at `queryPlanner` verbosity, which answers with the plan and
 * none of the command's documents.
 *
 * R1 `data-read`, where the SQL estimate is R0: with several candidate plans the server runs each for a bounded trial,
 * so the documents are read even though none is returned, and the command text is model-written and reaches the
 * engine. Not a statement read (`modelStatement` unset), because the command is planned rather than run: a plan is
 * evidence a run may cite, never an answer it may present. Its own id rather than a widened `sql.explain.estimate`,
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
  inputSchema: mongoAgentReadInput,
  verification: {
    reviewedBy: "MongoDB agent execution design review",
    boundary: MONGO_PLAN_BOUNDARY,
    verifiedOn: "2026-10-17",
  },
};

/**
 * The longest command Studio composes for a run, the collection profile's (`agent/languages/mongo/tools.ts`): room
 * for a batch of `MAX_PROFILE_COLUMNS` fields with long nested paths, since a field name has no length bound of its
 * own.
 */
const MONGO_COMPOSED_MAX_STATEMENT_CHARS = 65_536;

/**
 * The input of a command the SERVER composes: one command, read by the reader every command meets
 * (`readMongoCommand`), up to `MONGO_COMPOSED_MAX_STATEMENT_CHARS`.
 *
 * Its own input because the 4,096 characters of `mongoAgentReadInput` bound text a MODEL writes, and a composition is
 * not that: a profile of sixteen fields with long nested paths runs past it, and held to it the profile would be
 * refused by its own descriptor. The SQL profile meets no such cap: its input is the bounded read's, which has none.
 */
const mongoComposedReadInput = z
  .strictObject({ command: z.string().min(1).max(MONGO_COMPOSED_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const read = readMongoCommand(value.command);
    if (!read.ok) context.addIssue({ code: "custom", path: ["command"], message: read.message });
  });

const MONGO_PROFILE_BOUNDARY =
  "MongoDB: the profile's aggregation is composed by the SERVER from the run's own captured inventory - the model " +
  "supplies only the collection, the depth and where in its fields to start - and it runs under the same profiled " +
  "connection, reader, bound database, deadline and budgets as mongo.query.read. Only counts come back: no value is " +
  "read out of any field, which is what makes pointing a profile at a collection of personal data acceptable at all.";

/**
 * One MongoDB collection profile, composed as an aggregation and run under the profile's bounds.
 *
 * R1 `data-read` on the same boundary the model's own command reads take. The composition is server-authored from the
 * captured inventory (`agent/languages/mongo/tools.ts`), so what the pipeline validates and the engine runs is the
 * COMPOSED COMMAND - read by the same reader every model command meets, under a length bound of its own
 * (`mongoComposedReadInput`) - and never a word the model wrote: the selector it named was resolved against the run's
 * own inventory before this descriptor saw anything. Not a statement read (`modelStatement` unset), for the reason
 * `sql.table.profile` is not one: its statement is the server's. Its own id for the reason that one has its own: the
 * counts are the one reading an operator may want to deny without denying the reads the model itself writes.
 */
export const mongoTableProfileDescriptor: RegistrableOperationDescriptor = {
  id: "mongo.table.profile",
  riskClass: 1,
  accessLevel: "data-read",
  requiredCapabilities: [],
  resourceCost: "heavy",
  supportsDryRun: false,
  requiresApproval: false,
  inputSchema: mongoComposedReadInput,
  verification: {
    reviewedBy: "MongoDB agent execution design review",
    boundary: MONGO_PROFILE_BOUNDARY,
    verifiedOn: "2026-10-17",
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
  libredbkvQueryReadDescriptor,
  influxqlQueryReadDescriptor,
  weaviateapiQueryReadDescriptor,
  qdrantapiQueryReadDescriptor,
  cypherQueryReadDescriptor,
  milvusrpcQueryReadDescriptor,
  rediscliQueryReadDescriptor,
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
