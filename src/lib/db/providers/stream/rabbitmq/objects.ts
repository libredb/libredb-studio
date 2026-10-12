/**
 * The RabbitMQ object surface: three static kinds under one container level, the virtual host.
 *
 * A stream is a relation whose columns are the fixed shape of a read result; a queue and an exchange are
 * configuration, shown as labelled JSON parts and never read. Every kind's count comes from its own listing page,
 * so a kind whose count is unavailable has no listing either (`countIsListing`).
 */
import { QueryError } from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  callerBoundTruncationReason,
  type ContainerPathShapeEngine,
  findKind,
} from "@/lib/db/object-kinds";
import type {
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import {
  exchangesSampledFrom,
  queryError,
  queuesSampledFrom,
  STREAMS_HIDDEN_SENTENCE,
  streamsSampledFrom,
  unknownKind,
  VhostAccessError,
  vhostUnavailableSentence,
} from "./errors";
import { RABBITMQ_LISTING_PAGE_SIZE } from "./limits";
import type { GetOptions, ManagementClient, PageAnswer, QueuePageRow, StreamPageRow } from "./management/client";
import { RABBITMQ_STREAM_COLUMNS } from "./results";

export type RabbitMQKind = "stream" | "queue" | "exchange";

/** The three kinds, each id a `RabbitMQKind`, in the tree's folder order. */
export const RABBITMQ_OBJECT_KINDS: readonly (ObjectKindSpec & { readonly id: RabbitMQKind })[] = Object.freeze([
  {
    id: "stream",
    role: "relation",
    label: "Stream",
    labelPlural: "Streams",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "queue",
    role: "config",
    label: "Queue",
    labelPlural: "Queues",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
  {
    id: "exchange",
    role: "config",
    label: "Exchange",
    labelPlural: "Exchanges",
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
] as const);

// ============================================================================
// The readers (one GET per folder, from the listing pages of the management API)
// ============================================================================

/** One page of the Streams listing, read for a folder: the streams in the broker's ascending byte order. */
export interface StreamListing {
  readonly streams: readonly StreamPageRow[];
  readonly count: KindCount;
  readonly filteredCount: number;
}

/**
 * The Streams page the last stream listing of a virtual host read, held for the column read that follows it: the
 * object surface reads a folder's listing and then its columns, and a stream's columns are a constant table, so the
 * second read needs only the names. Held for one virtual host, and taken once.
 */
export interface StreamListingMemo {
  put(vhost: string, listing: StreamListing): void;
  take(vhost: string): StreamListing | undefined;
}

export function createStreamListingMemo(): StreamListingMemo {
  let held: { readonly vhost: string; readonly listing: StreamListing } | undefined;
  return {
    put(vhost, listing) {
      held = { vhost, listing };
    },
    take(vhost) {
      const found = held?.vhost === vhost ? held.listing : undefined;
      held = undefined;
      return found;
    },
  };
}

const RABBITMQ_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: "rabbitmq",
  label: "A RabbitMQ",
  shapeNames: "label",
};
const PATH_ENGINE = { code: "rabbitmq", label: "A RabbitMQ", attachedSegment: "required" } as const;
const QUEUE_TYPES: ReadonlySet<string> = new Set(["classic", "quorum"]);
const STREAM = "stream";
const DEFAULT_EXCHANGE_LABEL = "(AMQP default)";

/** The shared path checks word their refusal; it travels as this provider's own error, unchanged. */
function ownRefusal(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof QueryError) throw queryError(error.message);
    throw error;
  }
}

function vhostOf(capabilities: ProviderCapabilities, container: readonly string[]): string {
  ownRefusal(() => assertContainerPathShape(capabilities, container, RABBITMQ_CONTAINER_PATH_ENGINE));
  return container[0];
}

function requireKind(capabilities: ProviderCapabilities, kind: string): ObjectKindSpec {
  const spec = findKind(capabilities, kind);
  if (spec === undefined) throw unknownKind(kind);
  return spec;
}

/** UTF-8 byte order, the broker's own. */
const sortsAfterStream = (type: string): boolean => Buffer.compare(Buffer.from(type), Buffer.from(STREAM)) > 0;

const statusOf = (state: string | null) => (state === null || state === "running" ? {} : { status: state });

/**
 * The Streams page read as its folder: rows whose type sorts after "stream" are skipped, the stream rows that follow
 * are kept and reversed into ascending order. Complete when a non-stream row follows them or the virtual host holds
 * no more than one page; a floor when streams reach the page's end; hidden when other types fill the page.
 */
export function readStreamPage(page: PageAnswer<StreamPageRow>): StreamListing {
  let index = 0;
  while (index < page.items.length && sortsAfterStream(page.items[index].type)) index += 1;
  const start = index;
  while (index < page.items.length && page.items[index].type === STREAM) index += 1;
  const streams = page.items.slice(start, index).reverse();
  const followed = index < page.items.length;
  const filteredCount = page.filteredCount;
  if (followed || filteredCount <= RABBITMQ_LISTING_PAGE_SIZE)
    return { streams, count: { count: streams.length }, filteredCount };
  if (streams.length === 0) return { streams, count: { unavailable: STREAMS_HIDDEN_SENTENCE }, filteredCount };
  // The page can hold fewer than 500 streams when other types sort into it; the sentence names what it held.
  const sampledFrom = streamsSampledFrom(filteredCount, streams.length);
  return { streams, count: { count: streams.length, sampledFrom }, filteredCount };
}

function queueRows(page: PageAnswer<QueuePageRow>): readonly QueuePageRow[] {
  return page.items.filter((row) => QUEUE_TYPES.has(row.type));
}

async function readStreams(client: ManagementClient, vhost: string, options?: GetOptions): Promise<StreamListing> {
  return readStreamPage(await client.get("streams-page", { vhost }, options));
}

/** Every virtual host this account may list; "/" is marked as the walk's default, not as a session the broker holds. */
export async function listVhosts(client: ManagementClient, options?: GetOptions): Promise<Container[]> {
  return (await client.get("vhosts", {}, options)).map((row) => ({
    path: [row.name],
    name: row.name,
    level: 0,
    ...(row.name === "/" ? { isSessionDefault: true } : {}),
  }));
}

/**
 * The three folders' counts: the Queues page, the Streams page and the exchange page, each its own GET and its own
 * permit. A folder the account may not list counts as unavailable with the permissions sentence, never 0.
 */
export async function countKinds(
  client: ManagementClient,
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const vhost = vhostOf(capabilities, container);
  const [queues, streams, exchanges] = await Promise.allSettled([
    client.get("queues-page", { vhost }),
    readStreams(client, vhost),
    client.get("exchanges-page", { vhost }),
  ]);
  const refused = (reason: unknown): KindCount => {
    if (reason instanceof VhostAccessError) return { unavailable: vhostUnavailableSentence(reason.vhost) };
    throw reason;
  };
  const streamCount = streams.status === "fulfilled" ? streams.value.count : refused(streams.reason);
  let queueCount: KindCount;
  if (queues.status === "fulfilled") {
    const kept = queueRows(queues.value).length;
    const filtered = queues.value.filteredCount;
    // Streams complete gives an approximate queue total; it comes from two reads that are not atomic.
    const approximate = "count" in streamCount && !("sampledFrom" in streamCount) ? filtered - streamCount.count : null;
    queueCount =
      filtered <= RABBITMQ_LISTING_PAGE_SIZE
        ? { count: kept }
        : { count: kept, sampledFrom: queuesSampledFrom(filtered, approximate) };
  } else {
    queueCount = refused(queues.reason);
  }
  let exchangeCount: KindCount;
  if (exchanges.status === "fulfilled") {
    const { filteredCount, items } = exchanges.value;
    exchangeCount =
      filteredCount <= RABBITMQ_LISTING_PAGE_SIZE
        ? { count: items.length }
        : { count: items.length, sampledFrom: exchangesSampledFrom(filteredCount) };
  } else {
    exchangeCount = refused(exchanges.reason);
  }
  return { stream: streamCount, queue: queueCount, exchange: exchangeCount };
}

/** One folder's rows, from its kind's one page, in the broker's order; the Streams folder also fills the memo. */
export async function listKind(
  client: ManagementClient,
  capabilities: ProviderCapabilities,
  memo: StreamListingMemo,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  const vhost = vhostOf(capabilities, container);
  requireKind(capabilities, kind);
  if (kind === STREAM) {
    const listing = await readStreams(client, vhost);
    memo.put(vhost, listing);
    return listing.streams.map((row) => ({ path: [vhost, row.name], name: row.name, kind, ...statusOf(row.state) }));
  }
  if (kind === "queue") {
    return queueRows(await client.get("queues-page", { vhost })).map((row) => ({
      path: [vhost, row.name],
      name: row.name,
      kind,
      ...statusOf(row.state),
    }));
  }
  return (await client.get("exchanges-page", { vhost })).items.map((row) => ({
    path: [vhost, row.name],
    name: row.name === "" ? DEFAULT_EXCHANGE_LABEL : row.name,
    kind,
  }));
}

/** A declared kind and an object path of its shape, [virtual host, name], or this provider's refusal. */
export function requireObjectPath(capabilities: ProviderCapabilities, path: readonly string[], kind: string): void {
  const spec = requireKind(capabilities, kind);
  ownRefusal(() => assertObjectPathShape(capabilities, spec, kind, path, PATH_ENGINE));
}

/** A stream's columns are the read result's, a constant table; a queue and an exchange have none. No GET. */
export function describeKind(capabilities: ProviderCapabilities, path: readonly string[], kind: string): ObjectDetail {
  requireObjectPath(capabilities, path, kind);
  return { path, columns: kind === STREAM ? RABBITMQ_STREAM_COLUMNS : [], indexes: [], foreignKeys: [] };
}

/**
 * The columns of a folder's streams, from the listing just read when the memo holds it, else from one Streams page;
 * no GET for a queue or an exchange, which have no columns. The caller's bound and a full folder are both said.
 */
export async function describeKindBatch(
  client: ManagementClient,
  capabilities: ProviderCapabilities,
  memo: StreamListingMemo,
  container: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  const vhost = vhostOf(capabilities, container);
  requireKind(capabilities, kind);
  if (kind !== STREAM) return { details: [] };
  const listing = memo.take(vhost) ?? (await readStreams(client, vhost));
  const cut = limit !== undefined && listing.streams.length > limit;
  const chosen = cut ? listing.streams.slice(0, limit) : listing.streams;
  const details = chosen.map((row) => ({
    path: [vhost, row.name],
    columns: RABBITMQ_STREAM_COLUMNS,
    indexes: [],
    foreignKeys: [],
  }));
  const sampled = "sampledFrom" in listing.count ? listing.count.sampledFrom : undefined;
  if (!cut && sampled === undefined) return { details };
  const reasons = [
    ...(cut ? [callerBoundTruncationReason(chosen.length)] : []),
    ...(sampled === undefined ? [] : [sampled]),
  ];
  return { details, truncated: { limit: chosen.length, reason: reasons.join(", and ") } };
}
