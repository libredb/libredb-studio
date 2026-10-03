/**
 * The Milvus object surface: one container level, Database, from ListDatabases; one kind,
 * the collection, listed by one ShowCollections per database, names only and nothing per row, and counted as the
 * length of that same listing, so the count and the listing cannot disagree; a collection's columns and indexes when
 * it is opened; the agent's bulk column read through BatchDescribeCollection, at most 200 names a call, read by
 * position; and the reads of a collection's Source, which source.ts shapes.
 *
 * Every call goes through `surfaceCall`: one limiter permit per call in flight, released when the call settles, the
 * wait counted inside the call's own deadline; the database on the request and never as shared state;
 * and errors.ts's table for every failure, the server's text after Studio's words and withheld whole when it
 * holds the configured secret. The adapter's classification of a failure is kept beside the mapped error
 * in a WeakMap, never on it, so the raw server text in its `detail` travels with no error a route serialises.
 *
 * Only this module holds `batchDescribeCollection`, and nothing here loads a collection: describe,
 * indexes, partitions, statistics and both Source parts answer on an unloaded collection.
 */
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import type {
  Container,
  ContainerLevels,
  DatabaseObject,
  DatabaseType,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
} from "@/lib/db/types";
import { LimiterFullError, type LimiterTicket, type ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import {
  type CallOptions,
  type DescribeCollectionResponse,
  type MilvusClient,
  MilvusError,
  type WireIndexDescription,
} from "./client";
import {
  type MilvusErrorConnection,
  type MilvusErrorContext,
  statusFailure,
  toMilvusError,
  toProviderError,
} from "./errors";
import { statisticsRowCount } from "./monitoring";
import { collectionColumns } from "./schema";
import { milvusSourceParts } from "./source";

const PROVIDER: DatabaseType = "milvus";

/** The one kind: partitions, aliases and indexes are details of a collection, never tree objects. */
export const MILVUS_COLLECTION_KIND = "collection";

/** One container level, the Database, MongoDB's one-level shape. */
export const MILVUS_CONTAINER_LEVELS: ContainerLevels = [{ id: "schema", label: "Database", labelPlural: "Databases" }];

/**
 * The collection: a relation with columns and a JSON Source, whose count is its listing's length, so a refused count
 * is a refused listing and the agent's walk sends no second read for it (`countIsListing`).
 */
export const MILVUS_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  {
    id: MILVUS_COLLECTION_KIND,
    role: "relation",
    label: "Collection",
    labelPlural: "Collections",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
];

/** The reads one fan-out keeps in flight: the bulk describe's fallback and the Tables and index panels. */
export const MILVUS_FAN_OUT = 4;

const NO_DATABASE_VISIBLE =
  "Milvus lists no database visible to this Milvus user: a user sees only the databases it holds a privilege on.";

/** Where one call goes: the database it names, and the collection where it names one. */
export interface MilvusTarget {
  readonly database: string;
  readonly collection?: string;
}

/** What every call of a surface runs under. */
export interface MilvusSurfaceContext {
  /** The connection's database, used where a surface names none. */
  readonly database: string;
  /** This provider instance's limiter, under the engine key "milvus". */
  readonly limiter: ProviderLimiter;
  /** A fresh signal per call, carrying the call's 10 s deadline and the connection's close. */
  readonly signal: () => AbortSignal;
  readonly errors: MilvusErrorConnection;
  readonly secretForms: readonly string[];
}

/** The adapter's classification behind a mapped error; a WeakMap, so no raw server text rides on the error itself. */
const CAUSES = new WeakMap<object, MilvusError>();

/** The adapter's classification of the failure a surface call raised, or undefined for any other error. */
export function milvusCause(error: unknown): MilvusError | undefined {
  return typeof error === "object" && error !== null ? CAUSES.get(error) : undefined;
}

/** Whether a surface call was refused for want of a Milvus privilege (gRPC 7). */
export function refusedForPrivilege(error: unknown): boolean {
  return milvusCause(error)?.category === "permission-denied";
}

/** Whether a surface call met a server without the RPC (gRPC 12, "not supported by this server version"). */
export function unimplementedByServer(error: unknown): boolean {
  return milvusCause(error)?.category === "unimplemented";
}

/** The common.Status code a surface call was refused with, or undefined. */
export function refusedStatusCode(error: unknown): number | undefined {
  return milvusCause(error)?.status?.code;
}

/** errors.ts's facts for one call of a surface. */
export function surfaceErrorContext(
  context: MilvusSurfaceContext,
  operation: string,
  target: MilvusTarget,
  write = false,
): MilvusErrorContext {
  return {
    operation,
    write,
    database: target.database,
    ...(target.collection === undefined ? {} : { collection: target.collection }),
    connection: context.errors,
    secretForms: context.secretForms,
  };
}

function mapped(error: unknown, errors: MilvusErrorContext): Error {
  const provider = toProviderError(error, errors);
  if (error instanceof MilvusError) CAUSES.set(provider, error);
  return provider;
}

/**
 * One wire call under one limiter permit: the permit is taken with the call's own signal, so the wait
 * counts inside its deadline, and released when the call settles. `write` marks Load and Release, whose failure after
 * the send is an unknown outcome. A full queue is refused unchanged; a wait that ends at its deadline or at the
 * connection's close sent nothing, so it is never an unknown outcome.
 */
export async function surfaceCall<T>(
  context: MilvusSurfaceContext,
  operation: string,
  target: MilvusTarget,
  call: (options: CallOptions) => Promise<T>,
  write = false,
): Promise<T> {
  const errors = surfaceErrorContext(context, operation, target, write);
  const signal = context.signal();
  let ticket: LimiterTicket;
  try {
    ticket = await context.limiter.acquire(signal);
  } catch (error) {
    if (error instanceof LimiterFullError) throw error;
    throw mapped(toMilvusError(error, signal), { ...errors, write: false });
  }
  try {
    return await call({ db: target.database, signal });
  } catch (error) {
    throw mapped(error, errors);
  } finally {
    ticket.release();
  }
}

/**
 * `each` over `items` with at most `limit` in flight, the results in the items' order, etcd's fan-out: after the
 * first failure no further item starts, the reads in flight settle, and the first failure is raised.
 */
export async function inBoundedFlight<T, R>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<R>,
): Promise<R[]> {
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

const byName = (left: string, right: string): number => comparePaths([left], [right]);

/**
 * The databases, from one ListDatabases, in the repository's path order, the connection's own marked as the
 * session's. Milvus filters the list by the user's privileges, so an empty answer reads "visible to this user" and is
 * raised, never shown as a server with no database.
 */
export async function listMilvusDatabases(
  client: Pick<MilvusClient, "listDatabases">,
  context: MilvusSurfaceContext,
): Promise<Container[]> {
  const answer = await surfaceCall(context, "database listing", { database: context.database }, (options) =>
    client.listDatabases(options),
  );
  if (answer.db_names.length === 0) throw new QueryError(NO_DATABASE_VISIBLE, PROVIDER);
  return [...answer.db_names]
    .sort(byName)
    .map((name) => ({ path: [name], name, level: 0, isSessionDefault: name === context.database }));
}

/** The collection names of one database, from one ShowCollections, nothing read per row. */
export async function listMilvusCollectionNames(
  client: Pick<MilvusClient, "showCollections">,
  context: MilvusSurfaceContext,
  database: string,
): Promise<string[]> {
  const answer = await surfaceCall(context, `collection listing of database ${database}`, { database }, (options) =>
    client.showCollections(options),
  );
  return [...answer.collection_names].sort(byName);
}

/**
 * The collection count, the length of the same listing; a listing refused for want of a privilege is the folder's
 * own sentence, never a count of 0, and any other failure is raised.
 */
export async function countMilvusCollections(
  client: Pick<MilvusClient, "showCollections">,
  context: MilvusSurfaceContext,
  database: string,
): Promise<Record<string, KindCount>> {
  try {
    return { [MILVUS_COLLECTION_KIND]: { count: (await listMilvusCollectionNames(client, context, database)).length } };
  } catch (error) {
    if (refusedForPrivilege(error)) return { [MILVUS_COLLECTION_KIND]: { unavailable: (error as Error).message } };
    throw error;
  }
}

/** The collections of one database, each addressed `[database, collection]`. */
export async function listMilvusCollections(
  client: Pick<MilvusClient, "showCollections">,
  context: MilvusSurfaceContext,
  database: string,
): Promise<DatabaseObject[]> {
  const names = await listMilvusCollectionNames(client, context, database);
  return names.map((name) => ({ path: [database, name], name, kind: MILVUS_COLLECTION_KIND }));
}

// -- describe and the bulk describe -----------------------------------------------------------------------

/** Names per BatchDescribeCollection: 1,007 small schemas were 522,171 bytes, far below the receive cap. */
export const MILVUS_DESCRIBE_BATCH = 200;

/** Per-entry codes that leave an object out of a bulk describe: the listing changed in between. */
const ABSENT_CODES: ReadonlySet<number> = new Set([100, 800, 1100]);

/** Whether a failure says the collection, or its database, is not there any more; 2.6.25 says so with code 0. */
function absent(failure: MilvusError | undefined): boolean {
  const status = failure?.status;
  return status !== undefined && (ABSENT_CODES.has(status.code) || status.errorCode === "CollectionNotExists");
}

/** One collection's index descriptions; a collection with none answers 700 IndexNotExist, which is no index. */
export async function readCollectionIndexes(
  client: Pick<MilvusClient, "describeIndex">,
  context: MilvusSurfaceContext,
  database: string,
  collection: string,
): Promise<readonly WireIndexDescription[]> {
  try {
    const answer = await surfaceCall(
      context,
      `index read of collection ${collection}`,
      { database, collection },
      (options) => client.describeIndex({ collection_name: collection }, options),
    );
    return answer.index_descriptions;
  } catch (error) {
    if (refusedStatusCode(error) === 700) return [];
    throw error;
  }
}

/**
 * A collection opened in the tree: schema.ts's columns from one DescribeCollection, and one `IndexSchema` per index,
 * named with its one field, from one DescribeIndex. The index type, metric and build state are in the
 * Source; Milvus has no foreign key.
 */
export async function describeMilvusCollection(
  client: Pick<MilvusClient, "describeCollection" | "describeIndex">,
  context: MilvusSurfaceContext,
  database: string,
  collection: string,
): Promise<ObjectDetail> {
  const describe = await surfaceCall(
    context,
    `describe of collection ${collection}`,
    { database, collection },
    (options) => client.describeCollection({ collection_name: collection }, options),
  );
  const indexes = await readCollectionIndexes(client, context, database, collection);
  return {
    path: [database, collection],
    columns: collectionColumns(describe),
    indexes: indexes.map((index) => ({ name: index.index_name, columns: [index.field_name], unique: false })),
    foreignKeys: [],
  };
}

function detailOf(database: string, name: string, describe: DescribeCollectionResponse): ObjectDetail {
  return { path: [database, name], columns: collectionColumns(describe), indexes: [], foreignKeys: [] };
}

/**
 * At most 200 names per BatchDescribeCollection, one call at a time, entries read by position, never by the echoed
 * `collection_name`, which is the alias when an alias was asked. An entry succeeds only with code 0 and
 * `Success` together; a per-entry 100, 800 or 1100 leaves the object out; any other per-entry failure is raised.
 */
async function batchDescribe(
  client: Pick<MilvusClient, "batchDescribeCollection">,
  context: MilvusSurfaceContext,
  database: string,
  names: readonly string[],
): Promise<ObjectDetail[]> {
  const details: ObjectDetail[] = [];
  for (let start = 0; start < names.length; start += MILVUS_DESCRIBE_BATCH) {
    const chunk = names.slice(start, start + MILVUS_DESCRIBE_BATCH);
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time, each under its own permit.
    const answer = await surfaceCall(context, `bulk describe of database ${database}`, { database }, (options) =>
      client.batchDescribeCollection({ collection_name: chunk }, options),
    );
    if (answer.responses.length !== chunk.length) {
      throw new QueryError(
        `Milvus answered a bulk describe of ${chunk.length} collections with ${answer.responses.length} entries, so Studio cannot tell which entry describes which collection and reads none of them.`,
        PROVIDER,
      );
    }
    chunk.forEach((name, at) => {
      const entry = answer.responses[at];
      const failure = statusFailure(entry.status, "BatchDescribeCollection");
      if (failure === undefined) details.push(detailOf(database, name, entry));
      else if (!absent(failure)) {
        throw toProviderError(
          failure,
          surfaceErrorContext(context, `bulk describe of collection ${name}`, { database, collection: name }),
        );
      }
    });
  }
  return details;
}

/** The fallback: one DescribeCollection per collection, at most 4 in flight. */
async function describeEach(
  client: Pick<MilvusClient, "describeCollection">,
  context: MilvusSurfaceContext,
  database: string,
  names: readonly string[],
): Promise<ObjectDetail[]> {
  const described = await inBoundedFlight(names, MILVUS_FAN_OUT, async (name) => {
    try {
      const describe = await surfaceCall(
        context,
        `describe of collection ${name}`,
        { database, collection: name },
        (options) => client.describeCollection({ collection_name: name }, options),
      );
      return detailOf(database, name, describe);
    } catch (error) {
      if (absent(milvusCause(error))) return undefined;
      throw error;
    }
  });
  return described.filter((detail): detail is ObjectDetail => detail !== undefined);
}

/**
 * The agent's bulk column read of one database: fields only and no index, which DescribeIndex would read by
 * walking segments. The caller's `limit` is applied before any call, and `truncated` then names it in the
 * shared sentence. The batch answers in one round trip on 3.0.2 and 2.6.25, so the one-per-collection
 * fallback runs only on a server that answers UNIMPLEMENTED.
 */
export async function describeMilvusCollections(
  client: Pick<MilvusClient, "batchDescribeCollection" | "describeCollection">,
  context: MilvusSurfaceContext,
  database: string,
  names: readonly string[],
  limit?: number,
): Promise<ObjectDetailBatch> {
  const cut = limit !== undefined && names.length > limit;
  const kept = cut ? names.slice(0, limit) : names;
  let details: ObjectDetail[];
  try {
    details = await batchDescribe(client, context, database, kept);
  } catch (error) {
    if (!unimplementedByServer(error)) throw error;
    details = await describeEach(client, context, database, kept);
  }
  return cut ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
}

// -- the Source -------------------------------------------------------------------------------------------

export type MilvusSourceClient = Pick<
  MilvusClient,
  "describeCollection" | "describeIndex" | "getLoadState" | "getCollectionStatistics" | "showPartitions" | "listAliases"
>;

/**
 * The reads of a collection's Source: DescribeCollection first, which is the existence check, so an unknown collection
 * or database is refused with errors.ts's sentence before any other read; then DescribeIndex, GetLoadState,
 * GetCollectionStatistics, ShowPartitions and ListAliases together, each under its own permit. All of them answer on
 * an unloaded collection, so nothing here loads one.
 */
export async function readMilvusCollectionSource(
  client: MilvusSourceClient,
  context: MilvusSurfaceContext,
  database: string,
  collection: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const target: MilvusTarget = { database, collection };
  const named = { collection_name: collection };
  const describe = await surfaceCall(context, `Source read of collection ${collection}`, target, (options) =>
    client.describeCollection(named, options),
  );
  const [indexes, load, statistics, partitions, aliases] = await Promise.all([
    readCollectionIndexes(client, context, database, collection),
    surfaceCall(context, `load state read of collection ${collection}`, target, (options) =>
      client.getLoadState(named, options),
    ),
    surfaceCall(context, `statistics read of collection ${collection}`, target, (options) =>
      client.getCollectionStatistics(named, options),
    ),
    surfaceCall(context, `partition listing of collection ${collection}`, target, (options) =>
      client.showPartitions(named, options),
    ),
    surfaceCall(context, `alias listing of collection ${collection}`, target, (options) =>
      client.listAliases(named, options),
    ),
  ]);
  const rowCount = statisticsRowCount(statistics.stats);
  return {
    path: [database, collection],
    kind: MILVUS_COLLECTION_KIND,
    parts: milvusSourceParts(
      {
        describe,
        indexes,
        loadState: load.state,
        ...(rowCount === undefined ? {} : { rowCount }),
        partitions: partitions.partition_names,
        aliases: aliases.aliases,
        secretForms: context.secretForms,
      },
      limit,
    ),
  };
}
