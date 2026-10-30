/**
 * The Weaviate agent read-only profile's rules, from the answers in tests/fixtures/weaviate/1.40.2/agent-boundary/:
 * the viewer proof the server answers before every agent request, the metadata-only projection of every answer, and
 * the wording of an agent request's failure.
 *
 * - **The viewer proof.** `GET /v1/users/own-info` answers the key's roles with every permission's action
 *   (`own-info-*`). The key is proved a viewer when the server names at least one role and every action of every role
 *   is one of the built-in `viewer` role's twelve read actions; a role that also writes (`own-info-widened`, `admin`,
 *   `root`), a server with RBAC off, which answers no roles at all (`own-info-keyonly`), an OIDC group whose roles the
 *   answer does not list, an answer other than 200 (anonymous is 401, `own-info-anonymous`) or any shape Studio does
 *   not read refuses the profile. It runs before every agent request with no verdict kept, so a role widened between
 *   two requests (`own-info-drift-before`, `own-info-drift-after`) is refused at the next one.
 * - **Metadata only.** Every answer is projected through `src/lib/db/redaction/metadata-only.ts`: per operation a
 *   declared list of columns, each a name, a count or a flag read from a fixed place in the server's answer, so no
 *   stored property, vector or payload, and no description, module setting or base URL, reaches a row, a column name
 *   or a nested cell.
 * - **Failures without the server's words.** A refusal is worded by its HTTP status and category alone, since the
 *   server's message can echo what a request carried.
 *
 * Pure: it receives the answers and never a client.
 */
import { ExecutionProfileError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { type WeaviateAnswer, WeaviateError, type WeaviateRequest } from "./client";
import type { WeaviateAnswered } from "./execute";
import type { WeaviatePlan } from "./request";

type Json = Readonly<Record<string, unknown>>;

/** The built-in `viewer` role's actions on 1.40.2 (`own-info-viewer`): every one reads. */
export const WEAVIATE_VIEWER_ACTIONS: ReadonlySet<string> = new Set([
  "read_roles",
  "read_backups",
  "read_users",
  "read_cluster",
  "read_groups",
  "read_nodes",
  "read_collections",
  "read_data",
  "read_tenants",
  "read_replicate",
  "read_aliases",
  "read_mcp",
]);

const ACTION_WORD = /^[a-z_]{1,64}$/;
const NOTHING_SENT = "No agent request was sent.";

export const WEAVIATE_PROOF_SENTENCES = {
  keyless: `The agent read-only profile needs Weaviate to prove the connection's key holds a viewer role, and this connection has no key, so the server cannot say who reads. Put a viewer's API key in the connection's password, or in the agent credential. ${NOTHING_SENT}`,
  rbacOff: `Weaviate answers no roles for this key, which is how a server with RBAC off answers, so the key cannot be proved a viewer and is refused: turn RBAC on and give the agent a key with the viewer role. ${NOTHING_SENT}`,
  noRole: `Weaviate names no role for this key, so it cannot be proved a viewer and is refused. ${NOTHING_SENT}`,
  groups: `Weaviate names OIDC groups for this key, whose roles its answer does not list, so the key cannot be proved a viewer and is refused: give the agent a key whose roles are its own. ${NOTHING_SENT}`,
  /** `action` is a lower-case action word the server named, checked before it is shown. */
  widened: (action: string): string =>
    `The key's roles hold ${action}, which is not one of the viewer role's read actions, so the key is refused: give the agent a key with the viewer role only. ${NOTHING_SENT}`,
  unknownAction: `The key's roles hold an action Studio does not read, so the key is refused: give the agent a key with the viewer role only. ${NOTHING_SENT}`,
  status: (status: number): string =>
    `Weaviate answered HTTP ${status} when asked who this key is, so the key is not proved a viewer and is refused. ${NOTHING_SENT}`,
  unreadable: `Weaviate's answer about this key is not in the shape Studio reads, so the key is not proved a viewer and is refused. ${NOTHING_SENT}`,
} as const;

/** The refusal of an agent-profile open with no key: raised before anything is sent. */
export function keylessAgentRefusal(): ExecutionProfileError {
  return new ExecutionProfileError(WEAVIATE_PROOF_SENTENCES.keyless, "PROFILE_SERVER_UNENFORCED");
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(): ExecutionProfileError {
  return new ExecutionProfileError(WEAVIATE_PROOF_SENTENCES.unreadable, "PROFILE_UNSUPPORTED_TARGET");
}

/** The verdict on one `own-info` answer: returns when the key is a viewer, throws the refusal otherwise. */
export function readWeaviateViewerProof(answer: WeaviateAnswer): void {
  if (answer.status !== 200) {
    throw new ExecutionProfileError(WEAVIATE_PROOF_SENTENCES.status(answer.status), "PROFILE_UNSUPPORTED_TARGET");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    throw unreadable();
  }
  if (!isObject(parsed)) throw unreadable();
  const { roles, groups } = parsed;
  if (roles === null || roles === undefined) {
    throw new ExecutionProfileError(WEAVIATE_PROOF_SENTENCES.rbacOff, "PROFILE_SERVER_UNENFORCED");
  }
  if (!Array.isArray(roles)) throw unreadable();
  if (roles.length === 0)
    throw new ExecutionProfileError(WEAVIATE_PROOF_SENTENCES.noRole, "PROFILE_PRIVILEGES_TOO_BROAD");
  if (groups !== null && groups !== undefined) {
    if (!Array.isArray(groups)) throw unreadable();
    if (groups.length > 0)
      throw new ExecutionProfileError(WEAVIATE_PROOF_SENTENCES.groups, "PROFILE_PRIVILEGES_TOO_BROAD");
  }
  for (const role of roles) {
    if (!isObject(role) || !Array.isArray(role.permissions)) throw unreadable();
    for (const permission of role.permissions) {
      const action = isObject(permission) ? permission.action : undefined;
      if (typeof action !== "string") throw unreadable();
      if (WEAVIATE_VIEWER_ACTIONS.has(action)) continue;
      throw new ExecutionProfileError(
        ACTION_WORD.test(action) ? WEAVIATE_PROOF_SENTENCES.widened(action) : WEAVIATE_PROOF_SENTENCES.unknownAction,
        "PROFILE_PRIVILEGES_TOO_BROAD",
      );
    }
  }
}

/** The request the proof sends: the key's own record, with nothing the caller chose. */
export const WEAVIATE_OWN_INFO_REQUEST: WeaviateRequest = Object.freeze({
  op: "own_info",
  params: Object.freeze({}),
  query: Object.freeze({}),
});

/** Asks the server who the key is and proves it a viewer; `send` answers whatever the status. */
export async function proveWeaviateViewer(
  send: (request: WeaviateRequest, signal: AbortSignal) => Promise<WeaviateAnswer>,
  signal: AbortSignal,
): Promise<void> {
  readWeaviateViewerProof(await send(WEAVIATE_OWN_INFO_REQUEST, signal));
}

// ---------------------------------------------------------------------------------------------------------------------
// The metadata-only projections
// ---------------------------------------------------------------------------------------------------------------------

/** What an answer is projected as, by the operation and, for a node read, whether it lists shards. */
export type WeaviateProjectionId =
  | "meta"
  | "schema"
  | "collection"
  | "shards"
  | "tenants"
  | "aliases"
  | "nodes"
  | "node-shards"
  | "aggregate";

/** Where a flattened property's facts sit: its dotted path and its own definition. */
interface PropertyRow {
  readonly path: string;
  readonly property: Json;
}

const at = (source: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), source);

const keyCount = (value: unknown): number | undefined => (isObject(value) ? Object.keys(value).length : undefined);

const META: MetadataProjection<Json> = [
  { column: "version", kind: "name", read: (meta) => meta.version },
  { column: "modules", kind: "count", read: (meta) => keyCount(meta.modules) ?? 0 },
];

const SCHEMA: MetadataProjection<Json> = [
  { column: "collection", kind: "name", read: (definition) => definition.class },
  { column: "vectorizer", kind: "name", read: (definition) => definition.vectorizer, optional: true },
  { column: "properties", kind: "count", read: (definition) => listOrEmpty(definition.properties).length },
  { column: "named_vectors", kind: "count", read: (definition) => keyCount(definition.vectorConfig) ?? 0 },
  {
    column: "multi_tenant",
    kind: "flag",
    read: (definition) => at(definition, "multiTenancyConfig", "enabled"),
    optional: true,
  },
  {
    column: "auto_tenant_activation",
    kind: "flag",
    read: (definition) => at(definition, "multiTenancyConfig", "autoTenantActivation"),
    optional: true,
  },
  {
    column: "replication_factor",
    kind: "count",
    read: (definition) => at(definition, "replicationConfig", "factor"),
    optional: true,
  },
];

const COLLECTION: MetadataProjection<PropertyRow> = [
  { column: "property", kind: "name", read: (row) => row.path },
  {
    column: "data_type",
    kind: "name",
    read: (row) =>
      Array.isArray(row.property.dataType) && row.property.dataType.every((entry) => typeof entry === "string")
        ? row.property.dataType.join(",")
        : undefined,
  },
  { column: "tokenization", kind: "name", read: (row) => row.property.tokenization, optional: true },
  { column: "filterable", kind: "flag", read: (row) => row.property.indexFilterable, optional: true },
  { column: "searchable", kind: "flag", read: (row) => row.property.indexSearchable, optional: true },
];

const SHARDS: MetadataProjection<Json> = [
  { column: "shard", kind: "name", read: (shard) => shard.name },
  { column: "status", kind: "name", read: (shard) => shard.status },
  { column: "vector_queue_size", kind: "count", read: (shard) => shard.vectorQueueSize, optional: true },
];

const TENANTS: MetadataProjection<Json> = [
  { column: "tenant", kind: "name", read: (tenant) => tenant.name },
  { column: "status", kind: "name", read: (tenant) => tenant.activityStatus },
];

const ALIASES: MetadataProjection<Json> = [
  { column: "alias", kind: "name", read: (alias) => alias.alias },
  { column: "collection", kind: "name", read: (alias) => alias.class },
];

const NODES: MetadataProjection<Json> = [
  { column: "node", kind: "name", read: (node) => node.name },
  { column: "status", kind: "name", read: (node) => node.status },
  { column: "version", kind: "name", read: (node) => node.version, optional: true },
  { column: "objects", kind: "count", read: (node) => at(node, "stats", "objectCount"), optional: true },
  { column: "shards", kind: "count", read: (node) => at(node, "stats", "shardCount"), optional: true },
];

const NODE_SHARDS: MetadataProjection<Json> = [
  { column: "node", kind: "name", read: (shard) => shard.node },
  { column: "collection", kind: "name", read: (shard) => shard.class },
  { column: "shard", kind: "name", read: (shard) => shard.name },
  { column: "objects", kind: "count", read: (shard) => shard.objectCount, optional: true },
  { column: "vector_indexing_status", kind: "name", read: (shard) => shard.vectorIndexingStatus, optional: true },
  { column: "loaded", kind: "flag", read: (shard) => shard.loaded, optional: true },
];

const AGGREGATE: MetadataProjection<Json> = [
  { column: "collection", kind: "name", read: (count) => count.collection },
  { column: "tenant", kind: "name", read: (count) => count.tenant, optional: true },
  { column: "count", kind: "count", read: (count) => count.count },
];

const PROJECTIONS = {
  meta: META,
  schema: SCHEMA,
  collection: COLLECTION,
  shards: SHARDS,
  tenants: TENANTS,
  aliases: ALIASES,
  nodes: NODES,
  "node-shards": NODE_SHARDS,
  aggregate: AGGREGATE,
} as const satisfies Record<WeaviateProjectionId, MetadataProjection<never>>;

/** What `ProviderCapabilities.metadataOnly` states for Weaviate, derived from the projections themselves. */
export const WEAVIATE_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** The deepest nesting of object properties a collection read flattens; Weaviate's own console bound. */
const MAX_PROPERTY_DEPTH = 32;

function shapeError(): QueryError {
  return new QueryError(
    "Weaviate's answer is not in the shape Studio reads for this request, so it was withheld from agent mode.",
    "weaviate",
  );
}

function listOrEmpty(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function objects(value: unknown): readonly Json[] {
  if (!Array.isArray(value) || !value.every(isObject)) throw shapeError();
  return value;
}

function object(value: unknown): Json {
  if (!isObject(value)) throw shapeError();
  return value;
}

/** Every property of a definition, nested ones after their parent as `parent.child`. */
function properties(list: unknown, prefix: string, depth: number): PropertyRow[] {
  if (list === undefined || list === null) return [];
  if (depth > MAX_PROPERTY_DEPTH) throw shapeError();
  return objects(list).flatMap((property) => {
    const name = property.name;
    if (typeof name !== "string") throw shapeError();
    const path = `${prefix}${name}`;
    return [{ path, property }, ...properties(property.nestedProperties, `${path}.`, depth + 1)];
  });
}

/** Which projection an agent request's answer takes. */
export function weaviateProjectionOf(plan: WeaviatePlan): WeaviateProjectionId {
  switch (plan.route.op) {
    case "tenant":
      return "tenants";
    case "alias":
      return "aliases";
    case "nodes":
    case "collection_nodes":
      return plan.query.output === "verbose" ? "node-shards" : "nodes";
    default:
      return plan.route.op as WeaviateProjectionId;
  }
}

/** The count an aggregate answered: REST's `count`, or GraphQL's `Aggregate.<collection>[0].meta.count`. */
function aggregateCount(answer: unknown, answered: WeaviateAnswered): unknown {
  if (answered.path !== "graphql") return object(answer).count;
  const groups = at(answer, "data", "Aggregate", answered.plan.collection as string);
  if (!Array.isArray(groups) || groups.length !== 1) throw shapeError();
  return at(groups[0], "meta", "count");
}

function sourcesOf(id: WeaviateProjectionId, answer: unknown, answered: WeaviateAnswered): readonly unknown[] {
  switch (id) {
    case "meta":
      return [object(answer)];
    case "schema":
      return objects(object(answer).classes ?? []);
    case "collection":
      return properties(object(answer).properties, "", 1);
    case "shards":
      return objects(answer);
    case "tenants":
      return answered.plan.route.op === "tenant" ? [object(answer)] : objects(answer);
    case "aliases":
      return answered.plan.route.op === "alias" ? [object(answer)] : objects(object(answer).aliases);
    case "nodes":
      return objects(object(answer).nodes);
    case "node-shards":
      return objects(object(answer).nodes).flatMap((node) =>
        objects(node.shards ?? []).map((shard) => ({ ...shard, node: node.name })),
      );
    case "aggregate":
      return [
        {
          collection: answered.plan.collection,
          tenant: answered.plan.tenant,
          count: aggregateCount(answer, answered),
        },
      ];
  }
}

/**
 * An agent request's answer as rows: the projection of its operation, then the row and byte budgets, past which it
 * is refused rather than cut. A cell that fits no declared kind withholds the whole answer.
 */
export function shapeWeaviateAgentAnswer(
  answered: WeaviateAnswered,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answered.text);
  } catch {
    throw shapeError();
  }
  const id = weaviateProjectionOf(answered.plan);
  let projected: ReturnType<typeof projectMetadata>;
  try {
    projected = projectMetadata(PROJECTIONS[id] as MetadataProjection<unknown>, sourcesOf(id, parsed, answered));
  } catch (error) {
    if (error instanceof MetadataProjectionError) throw new QueryError(error.message, "weaviate", statement);
    throw error;
  }
  if (projected.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(projected.rows.length, budget.maxResultRows), "weaviate", statement);
  }
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "weaviate", statement);
  }
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime: answered.executionTime,
  };
}

/**
 * The agent's wording of a failure, or undefined for one the provider's own table words. A server refusal is worded
 * by its status and category alone, never its message; a transport timeout is the time budget's refusal.
 */
export function weaviateAgentFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if (error instanceof WeaviateError) {
    return new QueryError(
      `${error.message}. The server's own words are not passed on to agent mode, whose answers carry metadata only.`,
      "weaviate",
      statement,
    );
  }
  if ((error instanceof TransportError && error.kind === "timeout") || error instanceof TimeoutError) {
    return new QueryError(
      `${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`,
      "weaviate",
      statement,
    );
  }
  return undefined;
}
