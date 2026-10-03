/**
 * Load and Release, the only state changes the Milvus provider sends,
 * reached only through the admin-only, audited maintenance route and never from the console, the agent or MCP.
 *
 * Both are per-row operations with a preview: Load is confirmed plainly over the preview, and Release by the
 * collection's exact name. Read-only mode refuses both before any request, in etcd's sentences. One load at
 * a time per provider instance is Studio's own lock, because the server answers a second LoadCollection during a load
 * with Success; the preview and Load both refuse while GetLoadState answers LoadStateLoading, and Release is not
 * gated, so an administrator can still release a collection whose load does not finish.
 * LoadCollection returns in 15 to 103 ms and the load continues on the server, so Load then polls
 * GetLoadingProgress at once and every second for at most 10 s; a load the server continues after the poll is not
 * covered by the lock. A lost answer reads "may have been applied" and is never resent.
 */
import { DatabaseError, QueryError } from "@/lib/db/errors";
import type { DatabaseType, MaintenanceOperation, MaintenanceOperationSpec, MaintenancePreview } from "@/lib/db/types";
import type { VectorFieldInfo } from "@/lib/db/vector/types";
import type { MilvusClient, WireIndexDescription } from "./client";
import {
  formatMilvusBytes,
  loadStateWord,
  type QueryNodeMemory,
  ROW_COUNT_ESTIMATE,
  readSystemInfo,
  statisticsRowCount,
} from "./monitoring";
import { type MilvusSurfaceContext, readCollectionIndexes, surfaceCall } from "./objects";
import { MILVUS_NAME } from "./request";
import { indexParam, vectorFieldInfos, withIndexKinds } from "./schema";

/** Milvus's two operations, each its own member. */
export const MILVUS_MAINTENANCE_OPERATIONS: readonly MaintenanceOperation[] = ["load", "release"];

/** What Release does to every other client, the per-row control's description and the preview's summary. */
export const RELEASE_DESCRIPTION =
  "Every other client's search and query on this collection then fails with code 101 until it is loaded again.";

/** The two per-row specs: both previewed; Release confirmed by the collection's exact name. */
export const MILVUS_MAINTENANCE_SPECS: Partial<Record<MaintenanceOperation, MaintenanceOperationSpec>> = {
  load: { label: "Load", perEntity: true, global: false, preview: true },
  release: {
    label: "Release",
    perEntity: true,
    global: false,
    confirmation: "typed-target",
    preview: true,
    description: RELEASE_DESCRIPTION,
  },
};

/** The poll's interval and window: GetLoadingProgress reports only 0, 50 and 100. */
export const MILVUS_LOAD_POLL_MS = 1_000;
export const MILVUS_LOAD_WINDOW_MS = 10_000;

/**
 * One load at a time per provider instance: an in-memory FIFO lock, so per connection and per Studio process,
 * shared by every user of a shared seed. A waiter holds no limiter permit while it waits, and leaves the queue with
 * its signal's reason when that signal aborts, so `disconnect()` frees every waiter. A release given twice frees once.
 */
export class MilvusLoadLock {
  private locked = false;
  private readonly waiting: Array<() => void> = [];

  get held(): boolean {
    return this.locked;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const admit = (): void => {
        signal.removeEventListener("abort", leave);
        resolve(this.releaser());
      };
      const leave = (): void => {
        this.waiting.splice(this.waiting.indexOf(admit), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.waiting.push(admit);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.locked = false;
      else next();
    };
  }
}

/** The poll's pause, which holds no permit; an abort, the connection's close, ends it with the signal's reason. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

// -- the preview -------------------------------------------------------------------------------------------------------

const PROVIDER: DatabaseType = "milvus";
const LOADING = "LoadStateLoading";

/** The refusal of the preview and of Load while Milvus is still loading the collection, whoever started that load. */
export const STILL_LOADING =
  "This collection is still loading on the server; open the preview again once it reads Loaded.";

/** How fresh the memory figures are: GetMetrics answers from a 5 s cache that every read resets. */
export const METRICS_NOTE = "as reported by the server, possibly several seconds old";

/** The preview's reads and nothing else: no `loadCollection` and no `releaseCollection`. */
export type MilvusPreviewClient = Pick<
  MilvusClient,
  "describeCollection" | "getLoadState" | "getCollectionStatistics" | "describeIndex" | "getMetricsSystemInfo"
>;

export interface MilvusMaintenanceTarget {
  readonly database: string;
  readonly collection: string;
}

/**
 * The collection a per-row operation names: `[database, collection]`, or `[collection]` in the connection's database.
 * Each segment meets Milvus's name rule before any call, so a path that names nothing Milvus could hold sends nothing.
 */
export function maintenanceTarget(path: readonly string[], defaultDatabase: string): MilvusMaintenanceTarget {
  if (path.length < 1 || path.length > 2) {
    throw new QueryError(
      `A Milvus maintenance target is [database, collection] or [collection], received ${JSON.stringify(path)}; nothing was sent.`,
      PROVIDER,
    );
  }
  const target =
    path.length === 2 ? { database: path[0], collection: path[1] } : { database: defaultDatabase, collection: path[0] };
  for (const [label, name] of [
    ["database", target.database],
    ["collection", target.collection],
  ] as const) {
    if (!MILVUS_NAME.test(name)) {
      throw new QueryError(
        `${JSON.stringify(name)} is not a valid Milvus ${label} name: a name starts with a letter or _, holds only letters, digits and _, and is at most 255 characters; nothing was sent.`,
        PROVIDER,
      );
    }
  }
  return target;
}

function notRun(type: MaintenanceOperation): QueryError {
  return new QueryError(`Milvus runs Load and Release, and not ${type}.`, PROVIDER);
}

/** The query nodes' memory, or the sentence of the read that did not answer, which the preview's note carries. */
type MemoryRead = { readonly nodes: readonly QueryNodeMemory[] } | { readonly unavailable: string };

async function readQueryNodeMemory(
  client: Pick<MilvusClient, "getMetricsSystemInfo">,
  context: MilvusSurfaceContext,
): Promise<MemoryRead> {
  try {
    const answer = await surfaceCall(context, "metrics read", { database: context.database }, (options) =>
      client.getMetricsSystemInfo(options),
    );
    return { nodes: readSystemInfo(answer.response) };
  } catch (error) {
    // A server without GetMetrics, a user without the privilege, or text Studio cannot read: the figures are left
    // out and the note says why. Anything that is not a provider error is a defect and surfaces as itself.
    if (!(error instanceof DatabaseError)) throw error;
    return { unavailable: error.message };
  }
}

function memoryFacts(read: MemoryRead): MaintenancePreview["facts"] {
  if ("unavailable" in read) return [];
  const single = read.nodes.length === 1;
  const perNode = read.nodes.flatMap((node) =>
    node.memory === undefined || node.memoryUsage === undefined
      ? []
      : [
          {
            label: single ? "Query-node memory" : `Query node ${node.id} memory`,
            value: `${formatMilvusBytes(node.memoryUsage)} used of ${formatMilvusBytes(node.memory)}`,
          },
        ],
  );
  const loaded = read.nodes.flatMap((node) => (node.loadedBinlogSize === undefined ? [] : [node.loadedBinlogSize]));
  if (loaded.length === 0) return perNode;
  const total = loaded.reduce((sum, bytes) => sum + bytes, 0);
  return [...perNode, { label: "Data loaded on query nodes", value: formatMilvusBytes(total) }];
}

function memoryNote(read: MemoryRead): string {
  return "unavailable" in read
    ? `The server reported no query-node memory: ${read.unavailable}`
    : `Memory figures are ${METRICS_NOTE}; in standalone the memory is the whole process's.`;
}

function vectorFieldFact(field: VectorFieldInfo, indexes: readonly WireIndexDescription[]): string {
  const index = indexes.find((candidate) => candidate.field_name === field.name);
  if (index === undefined) return `${field.nativeType}, no index`;
  const indexType = indexParam(index, "index_type") ?? "type not reported";
  return `${field.nativeType}, index ${index.index_name} (${indexType}, ${field.nativeMetric ?? "metric not reported"}), ${index.state}`;
}

/**
 * What a Load will read into memory: after the existence check, GetLoadState, GetCollectionStatistics, DescribeIndex
 * and GetMetrics together, each under its own permit, so the preview never holds more than the provider's four. It
 * refuses while Milvus is still loading the collection, and for a vector field with no index, which the server would
 * refuse too. The memory estimate is worded "about the raw data again in shared memory", measured for IVF_FLAT.
 */
async function loadPreview(
  client: MilvusPreviewClient,
  context: MilvusSurfaceContext,
  target: MilvusMaintenanceTarget,
  fields: readonly VectorFieldInfo[],
): Promise<MaintenancePreview> {
  const { database, collection } = target;
  const named = { collection_name: collection };
  const [state, statistics, indexes, memory] = await Promise.all([
    surfaceCall(context, `load state read of collection ${collection}`, target, (options) =>
      client.getLoadState(named, options),
    ),
    surfaceCall(context, `statistics read of collection ${collection}`, target, (options) =>
      client.getCollectionStatistics(named, options),
    ),
    readCollectionIndexes(client, context, database, collection),
    readQueryNodeMemory(client, context),
  ]);
  const indexed = withIndexKinds(fields, indexes);
  const unindexed = indexed.filter((field) => field.indexKind === null).map((field) => field.name);
  const rowCount = statisticsRowCount(statistics.stats);
  const refusal =
    state.state === LOADING
      ? STILL_LOADING
      : unindexed.length > 0
        ? `Vector field ${unindexed.join(", ")} has no index, and Milvus loads only a collection whose vector fields are all indexed: create the index first; Studio does not create one.`
        : undefined;
  return {
    summary: `Load collection ${collection} of database ${database} into query-node memory: expect about the raw data again in shared memory, which every client of this cluster shares until it is released.`,
    facts: [
      { label: "Load state", value: loadStateWord(state.state) },
      ...(rowCount === undefined
        ? []
        : [{ label: "Rows (estimate)", value: `${Number(rowCount).toLocaleString("en-US")} (${ROW_COUNT_ESTIMATE})` }]),
      ...indexed.map((field) => ({ label: `Vector field ${field.name}`, value: vectorFieldFact(field, indexes) })),
      ...memoryFacts(memory),
    ],
    ...(refusal === undefined ? {} : { refusal }),
    note: memoryNote(memory),
  };
}

/** What a Release does: the load state now, and what it does to every other client. Never refused for a loading collection. */
async function releasePreview(
  client: MilvusPreviewClient,
  context: MilvusSurfaceContext,
  target: MilvusMaintenanceTarget,
): Promise<MaintenancePreview> {
  const state = await surfaceCall(context, `load state read of collection ${target.collection}`, target, (options) =>
    client.getLoadState({ collection_name: target.collection }, options),
  );
  return {
    summary: `Release collection ${target.collection} of database ${target.database} from query-node memory. ${RELEASE_DESCRIPTION}`,
    facts: [{ label: "Load state", value: loadStateWord(state.state) }],
  };
}

/**
 * The preview of a per-row operation, read RPCs only. The path's names are checked with no call; DescribeCollection
 * runs first, because it is the target's existence check and lists the vector fields, so an unknown collection or
 * database is refused in errors.ts's sentence before any other read.
 */
export async function previewMilvusMaintenance(
  client: MilvusPreviewClient,
  context: MilvusSurfaceContext,
  type: MaintenanceOperation,
  path: readonly string[],
): Promise<MaintenancePreview> {
  if (type !== "load" && type !== "release") throw notRun(type);
  const target = maintenanceTarget(path, context.database);
  const describe = await surfaceCall(context, `preview of collection ${target.collection}`, target, (options) =>
    client.describeCollection({ collection_name: target.collection }, options),
  );
  return type === "load"
    ? loadPreview(client, context, target, vectorFieldInfos(describe))
    : releasePreview(client, context, target);
}
