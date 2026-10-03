/**
 * The Qdrant object surface (vector-family spec 6.3): one kind, the collection, with no container level. The
 * listing is `GET /collections`, names only and filtered by the credential; a collection's columns are its
 * description's (the id, its vectors, its payload indexes) and the payload keys its sample finds; its Source is the
 * six reads of `readQdrantObjectSource`.
 *
 * Every read goes through the `send` the surface is handed (3.13): index.ts gives each call its own limiter permit
 * and the surface's deadline, and raises a failure in errors.ts's words, so nothing here retries, waits or words
 * an HTTP failure. Aliases are never tree objects and never resolved: a credential scoped to an alias lists no
 * collection, and opens it by the alias name in the console.
 *
 * `describeObjects` has no batch read to use, so it reads one description per collection at a concurrency of 4,
 * the bounded fallback the Couchbase provider set, and departs on purpose from the one-round-trip sentence of
 * `DatabaseProvider.describeObjects`; its columns are the declared ones only, because sampled keys never reach a
 * machine-facing surface.
 */
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
} from "@/lib/db/types";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { DatabaseType } from "@/lib/types";
import type { QdrantAnswer, QdrantOp, QdrantRequest, QdrantSend } from "./client";
import { type QdrantPayloadSample, qdrantSampledColumns, qdrantSampleRead, readQdrantPayloadSample } from "./sample";
import {
  type QdrantCollection,
  qdrantCount,
  qdrantDeclaredColumns,
  qdrantIndexes,
  qdrantPayloadIndexes,
  readQdrantCollection,
} from "./schema";
import { qdrantSourceParts } from "./source";

const PROVIDER: DatabaseType = "qdrant";

/** The one kind. */
const QDRANT_COLLECTION_KIND = "collection";

export const QDRANT_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: QDRANT_COLLECTION_KIND,
    role: "relation",
    label: "Collection",
    labelPlural: "Collections",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
]);

/** The descriptions in flight at once for `describeObjects` and the Tables and index panels (spec 6.6). */
export const QDRANT_DESCRIBE_CONCURRENCY = 4;

/** The deadline of a call outside a console request: connect, the tree, the Source, monitoring (spec 6.6). */
export const QDRANT_SURFACE_TIMEOUT_MS = 10_000;

/** What a listing shows where a credential is configured: the server filters it by what the credential may read. */
export const VISIBLE_TO_CREDENTIAL = "the collections visible to this credential";

/**
 * An empty listing: an open server with no collection, a token scoped to collections that do not exist yet, and a
 * token scoped to an alias all answer it, so it names none of them as the cause (spec 6.2, QE27).
 */
export const NO_COLLECTIONS_VISIBLE =
  "No collections are visible to this credential. A credential scoped to an alias lists none, and still opens the collection in the console by the alias name.";

/** The reads the object surface sends, and nothing else (3.13, interface segregation). */
export type QdrantObjectOp =
  | "get_collections"
  | "get_collection"
  | "get_collection_aliases"
  | "list_snapshots"
  | "get_optimizations"
  | "collection_cluster_info"
  | "scroll_points";

/** What one surface call runs with; index.ts builds one per call. */
export interface QdrantSurfaceContext<Ops extends QdrantOp> {
  /** One read under its own permit; a failed request or a non-2xx answer is raised in errors.ts's words. */
  readonly send: QdrantSend<Ops>;
  /** The surface's deadline, shared by every read of the call. */
  readonly signal: AbortSignal;
  /** The server has the `slice` condition (1.19.0), so the payload sample is uniform. */
  readonly sliceSupported: boolean;
  /** A credential is configured, so a listing holds what it may see rather than every collection. */
  readonly scoped: boolean;
}

export type QdrantObjectContext = QdrantSurfaceContext<QdrantObjectOp>;

/** An answer's `result`, its integers above 2^53 kept as exact digits; an answer that is not JSON is refused. */
export function readResult(answer: QdrantAnswer, what: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteUnsafeIntegers(answer.text));
  } catch {
    throw new QueryError(`Qdrant's answer to ${what} is not JSON Studio can read.`, PROVIDER);
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as { readonly result?: unknown }).result : undefined;
}

/** The names of the collections the credential may see, in the order Qdrant lists them. */
export async function listQdrantCollectionNames(
  context: QdrantSurfaceContext<"get_collections">,
): Promise<readonly string[]> {
  const answer = await context.send({ op: "get_collections", params: {}, query: {} }, context.signal);
  const result = readResult(answer, "the collection list");
  const listed =
    typeof result === "object" && result !== null ? (result as { collections?: unknown }).collections : undefined;
  if (!Array.isArray(listed)) throw new QueryError("Qdrant's collection list holds no collections array.", PROVIDER);
  return listed.flatMap((entry: unknown) => {
    const name = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
    return typeof name === "string" ? [name] : [];
  });
}

/**
 * A refusal of a read about one collection, naming that collection: a tree or a Source shows the sentence beside
 * no request text, so a plain `QueryError` that does not name the collection gets its name in front. Every other
 * class (an authentication, connection or timeout error) is raised as it is.
 */
function namedRefusal(error: unknown, name: string): unknown {
  if (!(error instanceof QueryError) || Object.getPrototypeOf(error) !== QueryError.prototype) return error;
  if (error.message.includes(name)) return error;
  return new QueryError(`Collection ${JSON.stringify(name)}: ${error.message}`, PROVIDER);
}

/** One read about the collection `name`. */
async function collectionRead<Ops extends QdrantOp>(
  context: QdrantSurfaceContext<Ops>,
  request: QdrantRequest & { readonly op: Ops },
  name: string,
): Promise<QdrantAnswer> {
  try {
    return await context.send(request, context.signal);
  } catch (error) {
    throw namedRefusal(error, name);
  }
}

/** One collection's description. */
async function readQdrantDescription(
  context: QdrantSurfaceContext<"get_collection">,
  name: string,
): Promise<QdrantCollection> {
  const answer = await collectionRead(
    context,
    { op: "get_collection", params: { collection_name: name }, query: {} },
    name,
  );
  return readQdrantCollection(name, readResult(answer, `the description of collection ${JSON.stringify(name)}`));
}

/**
 * `each` over `items` with at most `limit` in flight, the results in the items' order. After the first failure no
 * further item starts; the reads already in flight settle, and the first failure is raised.
 */
async function inBoundedFlight<T, R>(items: readonly T[], limit: number, each: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next;
      next += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- each worker holds one read in flight at a time, which is the bound.
        results[index] = await each(items[index]);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}

/** The descriptions of `names`, at most four in flight, in the order of `names`. */
export function describeQdrantCollections(
  context: QdrantSurfaceContext<"get_collection">,
  names: readonly string[],
): Promise<QdrantCollection[]> {
  return inBoundedFlight(names, QDRANT_DESCRIBE_CONCURRENCY, (name) => readQdrantDescription(context, name));
}

function requireKind(kind: string): void {
  if (kind !== QDRANT_COLLECTION_KIND) throw new QueryError(`Qdrant declares no object kind "${kind}"`, PROVIDER);
}

/** Every Qdrant path is one segment, the collection's name: no container level is declared. */
function collectionOf(path: readonly string[], kind: string): string {
  requireKind(kind);
  if (path.length !== 1) {
    throw new QueryError(`A Qdrant "${kind}" path is [name], received ${JSON.stringify(path)}`, PROVIDER);
  }
  return path[0];
}

/** The collection folder's count: exact on an open server, what the credential may see otherwise, and the empty listing's sentence. */
export async function countQdrantObjects(
  context: QdrantSurfaceContext<"get_collections">,
): Promise<Record<string, KindCount>> {
  const names = await listQdrantCollectionNames(context);
  const count: KindCount =
    names.length === 0
      ? { unavailable: NO_COLLECTIONS_VISIBLE }
      : context.scoped
        ? { count: names.length, sampledFrom: VISIBLE_TO_CREDENTIAL }
        : { count: names.length };
  return { [QDRANT_COLLECTION_KIND]: count };
}

/** The collections, names only: no row count and no status badge on a listing (spec 6.3). */
export async function listQdrantObjects(
  context: QdrantSurfaceContext<"get_collections">,
  kind: string,
): Promise<DatabaseObject[]> {
  requireKind(kind);
  return (await listQdrantCollectionNames(context)).map((name) => ({
    path: [name],
    name,
    kind: QDRANT_COLLECTION_KIND,
  }));
}

/** A described collection's payload sample: one scroll of 1,000 points without vectors, or none when it reports no points. */
async function readSample(
  context: QdrantSurfaceContext<"scroll_points">,
  collection: QdrantCollection,
): Promise<QdrantPayloadSample | null> {
  const read = qdrantSampleRead(collection.name, qdrantCount(collection.info.points_count), context.sliceSupported);
  if (read === null) return null;
  const answer = await collectionRead(context, read.request, collection.name);
  return readQdrantPayloadSample(collection.name, answer.text, read);
}

/** A collection's columns and indexes: its description, then its payload sample (two reads, one for an empty collection). */
export async function describeQdrantObject(
  context: QdrantSurfaceContext<"get_collection" | "scroll_points">,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  const collection = await readQdrantDescription(context, collectionOf(path, kind));
  const sample = await readSample(context, collection);
  const indexed = new Set(qdrantPayloadIndexes(collection).map((index) => index.key));
  return {
    path: [collection.name],
    columns: [...qdrantDeclaredColumns(collection), ...(sample === null ? [] : qdrantSampledColumns(sample, indexed))],
    indexes: [...qdrantIndexes(collection)],
    foreignKeys: [],
  };
}

/**
 * Every listed collection's declared columns: one listing, the caller's limit applied before any description is
 * read, then one description per collection, four in flight. No sample is read: sampled keys never reach grounding.
 */
export async function describeQdrantObjects(
  context: QdrantSurfaceContext<"get_collections" | "get_collection">,
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  requireKind(kind);
  const names = await listQdrantCollectionNames(context);
  const cut = limit !== undefined && names.length > limit;
  const described = await describeQdrantCollections(context, cut ? names.slice(0, limit) : names);
  const details = described.map(
    (collection): ObjectDetail => ({
      path: [collection.name],
      columns: [...qdrantDeclaredColumns(collection)],
      indexes: [...qdrantIndexes(collection)],
      foreignKeys: [],
    }),
  );
  return cut ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
}

/**
 * The Source: the description, the aliases, the snapshot list, the optimizations, the cluster information and the
 * payload sample, six reads one after another, five for a collection that reports no points. The sample is read
 * again here, because the Source is a request of its own and nothing is cached between requests; no snapshot is
 * downloaded.
 */
export async function readQdrantObjectSource(
  context: QdrantObjectContext,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const name = collectionOf(path, kind);
  const collection = await readQdrantDescription(context, name);
  const params = { collection_name: name };
  const read = async (
    op: "get_collection_aliases" | "list_snapshots" | "get_optimizations" | "collection_cluster_info",
    what: string,
  ) =>
    readResult(
      await context.send({ op, params, query: {} }, context.signal),
      `${what} of collection ${JSON.stringify(name)}`,
    );
  const aliases = await read("get_collection_aliases", "the aliases");
  const snapshots = await read("list_snapshots", "the snapshot list");
  const optimizations = await read("get_optimizations", "the optimizations");
  const cluster = await read("collection_cluster_info", "the cluster information");
  const sample = await readSample(context, collection);
  return {
    path: [name],
    kind,
    parts: qdrantSourceParts({ collection, aliases, snapshots, optimizations, cluster, sample }, limit),
  };
}
