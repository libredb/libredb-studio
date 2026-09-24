/**
 * The Kafka object surface (spec 4). Three flat kinds under the connection row, no
 * container level: one connection is one cluster. Partitions are not a kind; they
 * live in the topic's source, and a partition worth acting on surfaces as the topic's
 * status (spec 4.1).
 */
import type { ColumnSchema } from "@/lib/types";
import type {
  Container,
  ContainerLevels,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
  ProviderCapabilities,
} from "@/lib/db/types";
import { applySourceBound, assertObjectPathShape, callerBoundTruncationReason, findKind } from "@/lib/db/object-kinds";
import {
  BIGINT_ZERO,
  KafkaError,
  type KafkaConfigEntry,
  type KafkaReadClient,
  type KafkaTopicMetadata,
} from "./client";
import { readGroupSource } from "./groups";

export const KAFKA_CONTAINER_LEVELS: ContainerLevels = Object.freeze([] as const);

export const KAFKA_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "topic",
    role: "relation",
    label: "Topic",
    labelPlural: "Topics",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
  },
  {
    id: "consumer_group",
    role: "group",
    label: "Consumer Group",
    labelPlural: "Consumer Groups",
    hasSource: true,
    sourceLanguage: "json",
  },
  { id: "broker", role: "config", label: "Broker", labelPlural: "Brokers", hasSource: true, sourceLanguage: "json" },
] as const);

/** KM1: bounds how many topic names the tree and the inventory hold, below `INVENTORY_LIMIT`. */
export const KAFKA_TOPIC_LIST_CAP = 2000;

const TOPIC_CAP_SENTENCE = `one topic listing capped at ${KAFKA_TOPIC_LIST_CAP.toLocaleString("en-US")} names`;

const column = (name: string, type: string): ColumnSchema => ({ name, type, nullable: true, isPrimary: false });

/** The shape of a read result (spec 4.2, 5.2), not a schema the broker holds. */
export const KAFKA_TOPIC_COLUMNS: readonly ColumnSchema[] = Object.freeze([
  { name: "partition", type: "integer", nullable: false, isPrimary: false },
  { name: "offset", type: "string", nullable: false, isPrimary: false },
  { name: "timestamp", type: "timestamp", nullable: false, isPrimary: false },
  column("key", "json"),
  { name: "key_encoding", type: "string", nullable: false, isPrimary: false },
  column("value", "json"),
  { name: "value_encoding", type: "string", nullable: false, isPrimary: false },
  { name: "headers", type: "json", nullable: false, isPrimary: false },
]);

/** ConfigSource 5, DEFAULT_CONFIG. */
const DEFAULT_CONFIG_SOURCE = 5;
/** The protocol's ConfigSource numbers, in Kafka's own words; a number this build does not know is shown as itself. */
const CONFIG_SOURCES: Record<number, string> = {
  0: "unknown",
  1: "dynamic topic config",
  2: "dynamic broker config",
  3: "dynamic default broker config",
  4: "static broker config",
  5: "default",
  6: "dynamic broker logger config",
  7: "client metrics config",
  8: "group config",
};

const PATH_SHAPE = { code: "kafka", label: "A Kafka", attachedSegment: "required" } as const;

export type ObjectsClient = Pick<
  KafkaReadClient,
  | "metadata"
  | "listTopics"
  | "offsets"
  | "topicConfigs"
  | "brokerConfigs"
  | "listGroups"
  | "describeGroup"
  | "committedOffsets"
>;

export function listContainers(): Container[] {
  return [];
}

function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) {
    throw new KafkaError(
      "unknown-object",
      `A Kafka connection has no container level; received ${JSON.stringify(container)}`,
    );
  }
}

/** A state worth acting on, in the engine's words; a healthy topic has none (spec 4.1). */
export function topicStatus(topic: KafkaTopicMetadata): string | undefined {
  if (topic.partitions.some((p) => p.leader < 0)) return "offline";
  if (topic.partitions.some((p) => p.isr.length < p.replicas.length)) return "under-replicated";
  return undefined;
}

async function readTopics(client: ObjectsClient): Promise<{ names: string[]; capped: boolean }> {
  const names = await client.listTopics();
  return names.length > KAFKA_TOPIC_LIST_CAP
    ? { names: names.slice(0, KAFKA_TOPIC_LIST_CAP), capped: true }
    : { names, capped: false };
}

/** The one reader per kind that feeds both the count and the listing, so the count is the listed length (spec 4.3). */
async function readKind(client: ObjectsClient, kind: string): Promise<{ rows: DatabaseObject[]; capped: boolean }> {
  switch (kind) {
    case "topic": {
      const { names, capped } = await readTopics(client);
      if (names.length === 0) return { rows: [], capped };
      const metadata = await client.metadata(names);
      const byName = new Map(metadata.topics.map((t) => [t.name, t]));
      return {
        rows: names.map((name) => {
          const described = byName.get(name);
          const status = described === undefined ? undefined : topicStatus(described);
          return { path: [name], name, kind, ...(status === undefined ? {} : { status }) };
        }),
        capped,
      };
    }
    case "consumer_group":
      return {
        rows: (await client.listGroups()).map((g) => ({ path: [g.groupId], name: g.groupId, kind })),
        capped: false,
      };
    case "broker": {
      // Live brokers only, and no controller marker: on KRaft the Metadata answer's
      // controller id is a random live broker, not the controller (spec 4.1).
      const metadata = await client.metadata([]);
      return {
        rows: [...metadata.brokers]
          .sort((a, b) => a.nodeId - b.nodeId)
          .map((b) => ({ path: [String(b.nodeId)], name: `${b.nodeId} ${b.host}:${b.port}`, kind })),
        capped: false,
      };
    }
    default:
      throw new KafkaError("unknown-object", `Kafka declares no object kind ${JSON.stringify(kind)}`);
  }
}

export async function countObjects(
  client: ObjectsClient,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  requireRoot(container);
  // Each kind is its own read, so a refusal of one (a principal denied the group listing, a
  // broker that is down) answers that kind unavailable and leaves the others counted.
  const settled = await Promise.allSettled(KAFKA_OBJECT_KINDS.map((kind) => readKind(client, kind.id)));
  return Object.fromEntries(
    KAFKA_OBJECT_KINDS.map((kind, index): [string, KindCount] => {
      const outcome = settled[index];
      if (outcome.status === "rejected") {
        // Only a domain refusal is an answer; anything else is a defect and surfaces as itself.
        if (!(outcome.reason instanceof KafkaError)) throw outcome.reason;
        return [kind.id, { unavailable: outcome.reason.message }];
      }
      const { rows, capped } = outcome.value;
      return [kind.id, capped ? { count: rows.length, sampledFrom: TOPIC_CAP_SENTENCE } : { count: rows.length }];
    }),
  );
}

export async function listObjects(
  client: ObjectsClient,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  requireRoot(container);
  return (await readKind(client, kind)).rows;
}

function specFor(capabilities: ProviderCapabilities, path: readonly string[], kind: string): ObjectKindSpec {
  const spec = findKind(capabilities, kind);
  if (spec === undefined)
    throw new KafkaError("unknown-object", `Kafka declares no object kind ${JSON.stringify(kind)}`);
  assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE);
  return spec;
}

export async function describeObject(
  client: ObjectsClient,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  specFor(capabilities, path, kind);
  // Existence of a topic is a metadata read that never creates it (spec 4.5).
  if (kind === "topic") await client.metadata([path[0]]);
  return { path, columns: kind === "topic" ? KAFKA_TOPIC_COLUMNS : [], indexes: [], foreignKeys: [] };
}

/**
 * One round trip per container and kind (spec 4.2): the fixed columns for every listed topic,
 * from the listing read alone. The caller's bound is said in the one shared sentence, then
 * this provider's own cap, joined by ", and " when both bite.
 */
export async function describeObjects(
  client: ObjectsClient,
  container: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  requireRoot(container);
  if (kind !== "topic") return { details: [] };
  const { names, capped } = await readTopics(client);
  const cut = limit !== undefined && names.length > limit;
  const chosen = cut ? names.slice(0, limit) : names;
  const details = chosen.map((name) => ({ path: [name], columns: KAFKA_TOPIC_COLUMNS, indexes: [], foreignKeys: [] }));
  if (!cut && !capped) return { details };
  const reasons = [
    ...(cut ? [callerBoundTruncationReason(chosen.length)] : []),
    ...(capped ? [`the listing is ${TOPIC_CAP_SENTENCE}`] : []),
  ];
  return { details, truncated: { limit: chosen.length, reason: reasons.join(", and ") } };
}

/** Offsets are 64-bit, so they leave as decimal strings, never as JavaScript numbers. */
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** One part, cut at the caller's character bound through the shared helper, and marked only when cut. */
function part(id: string, label: string, value: unknown, limit: number | undefined): ObjectSourcePart {
  const bounded = applySourceBound(json(value), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

const renderConfigs = (entries: readonly KafkaConfigEntry[]) =>
  entries.map((c) => ({
    name: c.name,
    value: c.isSensitive && c.value === null ? "redacted by the broker" : c.value,
    source: CONFIG_SOURCES[c.source] ?? String(c.source),
    readOnly: c.readOnly,
  }));

async function topicSource(
  client: ObjectsClient,
  path: readonly string[],
  kind: string,
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const name = path[0];
  const metadata = await client.metadata([name]).catch((error) => {
    if (error instanceof KafkaError && error.category === "unknown-topic") {
      throw new KafkaError("unknown-topic", `Topic ${JSON.stringify(name)} does not exist`);
    }
    throw error;
  });
  const topic = metadata.topics[0];
  // The client reads a topic's offsets as a whole and fails while any partition has no
  // leader, so an offline topic's source shows its partitions without offsets (spec 4.1).
  const offline = topic.partitions.filter((p) => p.leader < 0).map((p) => p.partition);
  const [earliest, latest, configs] = await Promise.all([
    offline.length > 0 ? undefined : client.offsets(name, "earliest"),
    offline.length > 0 ? undefined : client.offsets(name, "high-watermark"),
    client.topicConfigs(name),
  ]);
  const partitions = topic.partitions.map((p) => {
    if (earliest === undefined || latest === undefined)
      return { ...p, earliestOffset: null, latestOffset: null, offsetSpan: null };
    const first = earliest.get(p.partition) ?? BIGINT_ZERO;
    const end = latest.get(p.partition) ?? BIGINT_ZERO;
    return { ...p, earliestOffset: first, latestOffset: end, offsetSpan: end - first };
  });
  const label =
    offline.length > 0
      ? `Partitions (offsets not read: partition ${offline.join(", ")} has no leader, and the client reads a topic's offsets as a whole)`
      : "Partitions (offset span is latest minus earliest, not a message count)";
  return {
    path,
    kind,
    parts: [
      part("partitions", label, partitions, limit),
      part(
        "configs",
        "Configs that differ from the default",
        renderConfigs(configs.filter((c) => c.source !== DEFAULT_CONFIG_SOURCE)),
        limit,
      ),
    ],
  };
}

export async function readObjectSource(
  client: ObjectsClient,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  specFor(capabilities, path, kind);
  const name = path[0];
  switch (kind) {
    case "topic":
      return topicSource(client, path, kind, limit);
    case "consumer_group": {
      const source = await readGroupSource(client, name);
      if (source === undefined)
        throw new KafkaError("unknown-object", `Consumer group ${JSON.stringify(name)} does not exist`);
      return {
        path,
        kind,
        parts: [
          part("group", "Group", source.group, limit),
          part("offsets", "Committed offsets and lag", source.lag, limit),
        ],
      };
    }
    case "broker": {
      const metadata = await client.metadata([]);
      if (!metadata.brokers.some((b) => String(b.nodeId) === name)) {
        throw new KafkaError("unknown-object", `Broker ${JSON.stringify(name)} does not exist`);
      }
      return {
        path,
        kind,
        parts: [part("configs", "Broker configs", renderConfigs(await client.brokerConfigs(Number(name))), limit)],
      };
    }
    default:
      throw new KafkaError("unknown-object", `Kafka declares no object kind ${JSON.stringify(kind)}`);
  }
}
