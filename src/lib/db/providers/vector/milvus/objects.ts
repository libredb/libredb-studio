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
import { comparePaths } from "@/lib/db/object-path";
import type {
  Container,
  ContainerLevels,
  DatabaseObject,
  DatabaseType,
  KindCount,
  ObjectKindSpec,
} from "@/lib/db/types";
import { LimiterFullError, type LimiterTicket, type ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import { type CallOptions, type MilvusClient, MilvusError } from "./client";
import { type MilvusErrorConnection, type MilvusErrorContext, toMilvusError, toProviderError } from "./errors";

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
