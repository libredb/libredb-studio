/**
 * The Qdrant agent read-only profile's rules, from the answers in tests/fixtures/qdrant/1.19.1/agent-boundary/: the
 * read-only proof the server answers before every agent request, the metadata-only projection of every answer, and
 * the wording of an agent request's failure.
 *
 * - **The read-only proof.** Qdrant has no read of who a key is, so the server is asked to refuse two writes that would
 *   change nothing. First an alias update with no action: the read-only key, a JWT whose access is `r` and every
 *   collection-scoped JWT are refused it 403 (`proof-alias-*`), while the API key, a JWT whose access is `m` or that
 *   names no access, and any key on a server with no key configured are answered 200. A JWT that writes one
 *   collection is refused it too, so the collections the key lists (`GET /collections`, which lists a
 *   collection-scoped JWT's own collections alone) are each sent a point delete of no point: refused 403 to every
 *   read-only principal, read past its access check and answered 400 `Empty update request` to one that can write
 *   that collection (`proof-delete-*`). Anything but 403 at either step refuses the profile, as does a list Studio
 *   does not read or one of more than 32 collections. It runs before every agent request with no verdict kept, so a
 *   collection the key could write that appeared since the last request is refused at the next one.
 * - **A JWT's own claims.** A JWT with `rw` on an alias, or on a name nothing has yet, is refused the alias update and
 *   lists no collection and no alias, so the server's answers pass it, while it writes through that alias
 *   (`proof-*-jwt-alias-write`, `write-upsert-alias-jwt-alias-write`). Studio holds the key, so before anything is sent
 *   a key in a JWT's shape is read for its claims and admitted only when its access is `r`, globally or on each
 *   collection it names, beside `exp`, `iat`, `nbf`, `sub` and `value_exists`; a key with no claims to read is left to
 *   the server's answers alone.
 * - **Metadata only.** Every answer is projected through `src/lib/db/redaction/metadata-only.ts`: per route a
 *   declared list of columns, each a name, a count or a flag read from a fixed place in the server's answer, so no
 *   stored payload or vector, and no configuration value the projection does not name, reaches a row, a column name
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
import { type QdrantAnswer, QdrantError, type QdrantOp, type QdrantProbe } from "./client";
import type { QdrantAnswered } from "./execute";

type Json = Readonly<Record<string, unknown>>;

/** The most collections the proof sends a no-op delete to; a key that lists more is refused. */
export const QDRANT_PROOF_MAX_COLLECTIONS = 32;

const NOTHING_SENT = "No agent request was sent.";
const GIVE_A_READER = "Give the agent the server's read-only API key, or a JWT whose access is r.";

export const QDRANT_PROOF_SENTENCES = {
  keyless: `The agent read-only profile needs Qdrant to prove the connection's key reads only, and this connection has no key, so the server cannot refuse a write for it. Put a read-only API key, or a JWT whose access is r, in the connection's password or in the agent credential. ${NOTHING_SENT}`,
  writes: `Qdrant accepted an empty alias update from this key, so the key can change the server: the API key, a JWT whose access is m or names none, and any key on a server with no key configured are answered so. ${GIVE_A_READER} ${NOTHING_SENT}`,
  writesCollection: `Qdrant read an empty point delete on a collection this key lists instead of refusing it, so the key can write that collection, as a JWT with rw access to it can. ${GIVE_A_READER} ${NOTHING_SENT}`,
  /** `step` is one of the proof's own three requests, never user text. */
  status: (status: number, step: string): string =>
    `Qdrant answered HTTP ${status} to ${step}, so the key is not proved read-only and is refused. ${NOTHING_SENT}`,
  tooMany: (count: number): string =>
    `This key lists ${count} collections, more than the ${QDRANT_PROOF_MAX_COLLECTIONS} the read-only proof checks one by one, so the key is not proved read-only and is refused: give the agent a JWT whose access is r on the collections it should read. ${NOTHING_SENT}`,
  unreadable: `Qdrant's list of collections is not in the shape Studio reads, so the key is not proved read-only and is refused. ${NOTHING_SENT}`,
  claims: `This key is a JWT whose claims grant more than access r, globally or on each collection it names, or carry a claim Studio does not read, so the key may write, as a JWT with rw on an alias does though the server lists it nothing, and is refused. ${GIVE_A_READER} ${NOTHING_SENT}`,
} as const;

const STEPS = {
  alias: "an empty alias update",
  list: "the list of collections",
  delete: "an empty point delete",
} as const;

/** The refusal of an agent-profile open with no key: raised before anything is sent. */
export function keylessAgentRefusal(): ExecutionProfileError {
  return new ExecutionProfileError(QDRANT_PROOF_SENTENCES.keyless, "PROFILE_SERVER_UNENFORCED");
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The verdict on one probe's answer: returns when the server refused it 403, throws the refusal otherwise. */
export function readQdrantProbeAnswer(answer: QdrantAnswer, probe: QdrantProbe): void {
  if (answer.status === 403) return;
  const alias = probe.kind === "empty-alias-update";
  if (answer.status === 200 || (!alias && answer.status === 400)) {
    throw new ExecutionProfileError(
      alias ? QDRANT_PROOF_SENTENCES.writes : QDRANT_PROOF_SENTENCES.writesCollection,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  throw new ExecutionProfileError(
    QDRANT_PROOF_SENTENCES.status(answer.status, alias ? STEPS.alias : STEPS.delete),
    "PROFILE_UNSUPPORTED_TARGET",
  );
}

/** The collections a `GET /collections` answer lists, or the refusal of an answer Studio does not read. */
export function readQdrantProofCollections(answer: QdrantAnswer): readonly string[] {
  if (answer.status !== 200) {
    throw new ExecutionProfileError(
      QDRANT_PROOF_SENTENCES.status(answer.status, STEPS.list),
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    parsed = undefined;
  }
  const listed = isObject(parsed) && isObject(parsed.result) ? parsed.result.collections : undefined;
  if (!Array.isArray(listed)) throw unreadableList();
  const names = listed.map((entry) => (isObject(entry) ? entry.name : undefined));
  if (!names.every((name): name is string => typeof name === "string")) throw unreadableList();
  if (names.length > QDRANT_PROOF_MAX_COLLECTIONS) {
    throw new ExecutionProfileError(QDRANT_PROOF_SENTENCES.tooMany(names.length), "PROFILE_UNSUPPORTED_TARGET");
  }
  return names;
}

function unreadableList(): ExecutionProfileError {
  return new ExecutionProfileError(QDRANT_PROOF_SENTENCES.unreadable, "PROFILE_UNSUPPORTED_TARGET");
}

/** The claims a JWT may carry beside `access`, none of which grants a right. */
const CLAIMS_BESIDE_ACCESS: ReadonlySet<string> = new Set(["exp", "iat", "nbf", "sub", "value_exists"]);

/** The claims of a key in a JWT's shape whose payload is a JSON object, or undefined for a key with none to read. */
function jwtClaimsOf(key: string): Json | undefined {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
    return isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

/** `r` globally, or a list of `{collection, access: "r"}` entries and nothing else. */
function readsOnly(access: unknown): boolean {
  if (access === "r") return true;
  return (
    Array.isArray(access) &&
    access.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.collection === "string" &&
        entry.access === "r" &&
        Object.keys(entry).length === 2,
    )
  );
}

/** Refuses a key in a JWT's shape whose claims grant more than reading; a key with no claims to read passes. */
function readQdrantKeyClaims(key: string): void {
  const claims = jwtClaimsOf(key);
  if (claims === undefined) return;
  const others = Object.keys(claims).some((claim) => claim !== "access" && !CLAIMS_BESIDE_ACCESS.has(claim));
  if (others || !readsOnly(claims.access)) {
    throw new ExecutionProfileError(QDRANT_PROOF_SENTENCES.claims, "PROFILE_PRIVILEGES_TOO_BROAD");
  }
}

/**
 * What the proof reads and sends: the connection's key, the client's two probes, and the collection list, each
 * answered whatever its status.
 */
export interface QdrantProofWire {
  readonly key: string;
  readonly probe: (probe: QdrantProbe, signal: AbortSignal) => Promise<QdrantAnswer>;
  readonly listCollections: (signal: AbortSignal) => Promise<QdrantAnswer>;
}

/**
 * Proves the key reads only: a JWT's claims read first, then an empty alias update refused, then an empty point delete
 * refused on every collection the key lists, one request after another. Throws the refusal at the first that is not.
 */
export async function proveQdrantReadOnly(wire: QdrantProofWire, signal: AbortSignal): Promise<void> {
  readQdrantKeyClaims(wire.key);
  const alias: QdrantProbe = { kind: "empty-alias-update" };
  readQdrantProbeAnswer(await wire.probe(alias, signal), alias);
  for (const collection of readQdrantProofCollections(await wire.listCollections(signal))) {
    const remove: QdrantProbe = { kind: "empty-point-delete", collection };
    // oxlint-disable-next-line no-await-in-loop -- the proof's requests go one after another, as every request does.
    readQdrantProbeAnswer(await wire.probe(remove, signal), remove);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The metadata-only projections
// ---------------------------------------------------------------------------------------------------------------------

/** What an answer is projected as, by its route. */
export type QdrantProjectionId = "version" | "collections" | "collection" | "exists" | "aliases" | "count" | "cluster";

const at = (source: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), source);

/** One row of a collection read: the collection itself, a vector, a sparse vector or a payload index. */
interface CollectionRow {
  readonly kind: "collection" | "vector" | "sparse_vector" | "payload_index";
  /** The collection, vector or payload field's name; null for a collection's one unnamed vector. */
  readonly name: unknown;
  readonly facts: Json;
}

const VERSION: MetadataProjection<Json> = [
  { column: "version", kind: "name", read: (root) => root.version },
  { column: "commit", kind: "name", read: (root) => root.commit, optional: true },
];

const COLLECTIONS: MetadataProjection<Json> = [{ column: "collection", kind: "name", read: (entry) => entry.name }];

/** A collection's own row reads its facts; every other row answers null there. */
const own = (row: CollectionRow, read: (facts: Json) => unknown): unknown =>
  row.kind === "collection" ? read(row.facts) : undefined;

/** `optimizer_status` is `ok`, or an object holding the optimizer's error text, which is answered as `error` alone. */
function optimizerStatus(value: unknown): unknown {
  return isObject(value) && Object.hasOwn(value, "error") ? "error" : value;
}

const COLLECTION: MetadataProjection<CollectionRow> = [
  { column: "name", kind: "name", read: (row) => row.name, optional: true },
  { column: "kind", kind: "name", read: (row) => row.kind },
  { column: "status", kind: "name", read: (row) => own(row, (facts) => facts.status), optional: true },
  {
    column: "type",
    kind: "name",
    read: (row) =>
      row.kind === "vector" ? row.facts.distance : row.kind === "payload_index" ? row.facts.data_type : undefined,
    optional: true,
  },
  {
    column: "size",
    kind: "count",
    read: (row) => (row.kind === "vector" ? row.facts.size : undefined),
    optional: true,
  },
  {
    column: "points",
    kind: "count",
    read: (row) =>
      row.kind === "collection" ? row.facts.points_count : row.kind === "payload_index" ? row.facts.points : undefined,
    optional: true,
  },
  {
    column: "indexed_vectors",
    kind: "count",
    read: (row) => own(row, (facts) => facts.indexed_vectors_count),
    optional: true,
  },
  { column: "segments", kind: "count", read: (row) => own(row, (facts) => facts.segments_count), optional: true },
  {
    column: "shards",
    kind: "count",
    read: (row) => own(row, (facts) => at(facts, "config", "params", "shard_number")),
    optional: true,
  },
  {
    column: "replication_factor",
    kind: "count",
    read: (row) => own(row, (facts) => at(facts, "config", "params", "replication_factor")),
    optional: true,
  },
  {
    column: "optimizer_status",
    kind: "name",
    read: (row) => own(row, (facts) => optimizerStatus(facts.optimizer_status)),
    optional: true,
  },
];

const EXISTS: MetadataProjection<Json> = [
  { column: "collection", kind: "name", read: (row) => row.collection },
  { column: "exists", kind: "flag", read: (row) => row.exists },
];

const ALIASES: MetadataProjection<Json> = [
  { column: "alias", kind: "name", read: (alias) => alias.alias_name },
  { column: "collection", kind: "name", read: (alias) => alias.collection_name },
];

const COUNT: MetadataProjection<Json> = [
  { column: "collection", kind: "name", read: (row) => row.collection },
  { column: "count", kind: "count", read: (row) => row.count },
];

/** One shard of a cluster read, beside where it sits. */
interface ShardRow {
  readonly location: "local" | "remote";
  readonly shard: Json;
}

const CLUSTER: MetadataProjection<ShardRow> = [
  { column: "shard", kind: "count", read: (row) => row.shard.shard_id },
  { column: "location", kind: "name", read: (row) => row.location },
  { column: "state", kind: "name", read: (row) => row.shard.state },
  { column: "points", kind: "count", read: (row) => row.shard.points_count, optional: true },
];

const PROJECTIONS = {
  version: VERSION,
  collections: COLLECTIONS,
  collection: COLLECTION,
  exists: EXISTS,
  aliases: ALIASES,
  count: COUNT,
  cluster: CLUSTER,
} as const satisfies Record<QdrantProjectionId, MetadataProjection<never>>;

/** What `ProviderCapabilities.metadataOnly` states for Qdrant, derived from the projections themselves. */
export const QDRANT_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** Which projection an agent route's answer takes; every route `QDRANT_AGENT_OPS` names has one. */
const PROJECTION_OF: Readonly<Partial<Record<QdrantOp, QdrantProjectionId>>> = Object.freeze({
  root: "version",
  get_collections: "collections",
  get_collection: "collection",
  collection_exists: "exists",
  get_collections_aliases: "aliases",
  get_collection_aliases: "aliases",
  count_points: "count",
  collection_cluster_info: "cluster",
});

export function qdrantProjectionOf(op: QdrantOp): QdrantProjectionId {
  const id = PROJECTION_OF[op];
  if (id === undefined) throw new Error(`No metadata projection reads a ${op} answer`);
  return id;
}

function shapeError(): QueryError {
  return new QueryError(
    "Qdrant's answer is not in the shape Studio reads for this request, so it was withheld from agent mode.",
    "qdrant",
  );
}

function objects(value: unknown): readonly Json[] {
  if (!Array.isArray(value) || !value.every(isObject)) throw shapeError();
  return value;
}

function object(value: unknown): Json {
  if (!isObject(value)) throw shapeError();
  return value;
}

/** A map of named definitions (`{name: {...}}`), or none where the answer has no such key. */
function named(value: unknown): readonly [string, Json][] {
  if (value === undefined || value === null) return [];
  return Object.entries(object(value)).map(([name, definition]) => [name, object(definition)]);
}

/** The collection's own row, then its vectors, its sparse vectors and its payload indexes, each in the answer's order. */
function collectionRows(result: Json, collection: string): CollectionRow[] {
  const params = object(at(result, "config", "params") ?? {});
  const rows: CollectionRow[] = [{ kind: "collection", name: collection, facts: result }];
  const vectors = params.vectors;
  // The one unnamed vector has a numeric size; a named vector may be called `size`, and its definition is an object.
  if (isObject(vectors) && typeof vectors.size === "number") {
    rows.push({ kind: "vector", name: null, facts: vectors });
  } else {
    for (const [name, facts] of named(vectors)) rows.push({ kind: "vector", name, facts });
  }
  for (const [name, facts] of named(params.sparse_vectors)) rows.push({ kind: "sparse_vector", name, facts });
  for (const [name, facts] of named(result.payload_schema)) rows.push({ kind: "payload_index", name, facts });
  return rows;
}

function sourcesOf(id: QdrantProjectionId, answer: unknown, answered: QdrantAnswered): readonly unknown[] {
  const collection = answered.plan.request.params.collection_name;
  if (id === "version") return [object(answer)];
  const result = object(answer).result;
  switch (id) {
    case "collections":
      return objects(object(result).collections);
    case "collection":
      return collectionRows(object(result), collection);
    case "exists":
      return [{ collection, exists: object(result).exists }];
    case "aliases":
      return objects(object(result).aliases);
    case "count":
      return [{ collection, count: object(result).count }];
    case "cluster": {
      const layout = object(result);
      return [
        ...objects(layout.local_shards).map((shard): ShardRow => ({ location: "local", shard })),
        ...objects(layout.remote_shards).map((shard): ShardRow => ({ location: "remote", shard })),
      ];
    }
  }
}

/**
 * An agent request's answer as rows: the projection of its route, then the row and byte budgets, past which it is
 * refused rather than cut. A cell that fits no declared kind withholds the whole answer.
 */
export function shapeQdrantAgentAnswer(
  answered: QdrantAnswered,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answered.text);
  } catch {
    throw shapeError();
  }
  const id = qdrantProjectionOf(answered.plan.route.op);
  let projected: ReturnType<typeof projectMetadata>;
  try {
    projected = projectMetadata(PROJECTIONS[id] as MetadataProjection<unknown>, sourcesOf(id, parsed, answered));
  } catch (error) {
    if (error instanceof MetadataProjectionError) throw new QueryError(error.message, "qdrant", statement);
    throw error;
  }
  if (projected.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(projected.rows.length, budget.maxResultRows), "qdrant", statement);
  }
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "qdrant", statement);
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
 * by its status and category alone, never its message; a transport timeout or the request's deadline is the time
 * budget's refusal.
 */
export function qdrantAgentFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if (error instanceof QdrantError) {
    return new QueryError(
      `${error.message}. The server's own words are not passed on to agent mode, whose answers carry metadata only.`,
      "qdrant",
      statement,
    );
  }
  if ((error instanceof TransportError && error.kind === "timeout") || error instanceof TimeoutError) {
    return new QueryError(
      `${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`,
      "qdrant",
      statement,
    );
  }
  return undefined;
}
