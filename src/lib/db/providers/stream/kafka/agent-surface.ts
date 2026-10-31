/**
 * What a Kafka handle opened for an agent-mode profile answers outside `queryReadOnly`: the object surface the
 * grounding walk and MCP `inspect_schema` read, and the readings of the operations workflow. Every read here goes
 * through the agent's client (`KafkaAgentReadClient`), which holds the Metadata and ListOffsets reads alone.
 *
 * Metadata only, as the agent's reads are: topics are listed by name and status and described by the agent read's
 * columns, never a record cell; a broker is named by its node id, never its advertised host and port; consumer groups,
 * topic and broker configs and log directories are not read, and each kind or figure that needs one is answered by
 * its reason, never by an empty answer or a zero, so the model is told what it was not shown rather than reading an
 * absence as the broker's own answer. The editor's handles keep every surface.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseObject, HealthInfo, KindCount } from "@/lib/db/types";
import type { KafkaAgentReadClient } from "./client";
import { KAFKA_OBJECT_KINDS, listTopicObjects, requireRoot, TOPIC_CAP_SENTENCE } from "./objects";

const KAFKA_TYPE = "kafka";

const AGENT_READS =
  "Agent mode on Kafka reads metadata only, through the Metadata and ListOffsets requests: topic names, partitions, broker node ids and racks, the cluster id, and each partition's earliest and end offsets.";

/** Each kind or figure an agent-mode handle does not read, with its reason. No sentence names a broker value. */
export const KAFKA_AGENT_WITHHELD = {
  groups: `${AGENT_READS} Consumer groups (their ids, members, client ids and hosts, committed offsets and lag) are not read in agent mode, so none is listed or counted.`,
  logDirs: `${AGENT_READS} The size on disk is read from the brokers' log directories, which agent mode does not read, so it is not reported.`,
  storage: `${AGENT_READS} Storage is read from the brokers' log directories, which agent mode does not read, so no storage reading is taken.`,
  overview: `${AGENT_READS} The overview reads the brokers' configs and log directories, which agent mode does not read.`,
  sessions: `${AGENT_READS} Kafka reports no client sessions over its protocol, so no session reading is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} Kafka keeps no query log, so no slow-query reading is taken; this is not a reading of none.`,
  tableStats: `${AGENT_READS} A topic has no honest message count, so no table reading is taken; read a topic's offsets with run_read_query, whose offset span is not a message count either.`,
  indexStats: `${AGENT_READS} A topic has no index, so no index reading is taken; this is not a reading of none.`,
  source: `${AGENT_READS} An object's source holds configs, consumer group members and committed offsets, which agent mode does not read.`,
  query: `${AGENT_READS} A record's key, value, headers and timestamp are stored values, so the editor's read request, which fetches records, is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
} as const;

const refusal = (sentence: string) => new QueryError(sentence, KAFKA_TYPE);

/** The live brokers, named by node id alone. */
async function brokerObjects(client: KafkaAgentReadClient): Promise<DatabaseObject[]> {
  const { brokers } = await client.metadata([]);
  return [...brokers]
    .sort((a, b) => a.nodeId - b.nodeId)
    .map((b) => ({ path: [String(b.nodeId)], name: String(b.nodeId), kind: "broker" }));
}

/** One kind's listing on an agent-mode handle; a consumer group is refused with its reason. */
export async function agentListObjects(
  client: KafkaAgentReadClient,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  requireRoot(container);
  switch (kind) {
    case "topic":
      return (await listTopicObjects(client)).rows;
    case "broker":
      return brokerObjects(client);
    case "consumer_group":
      throw refusal(KAFKA_AGENT_WITHHELD.groups);
    default:
      throw refusal(`Kafka declares no object kind ${JSON.stringify(kind)}`);
  }
}

/**
 * Every kind's count on an agent-mode handle: topics and brokers as their listings, and the consumer groups by the
 * reason they are withheld, which the grounding walk carries to the model since the kind declares `countIsListing`.
 */
export async function agentCountObjects(
  client: KafkaAgentReadClient,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  requireRoot(container);
  const topics = await listTopicObjects(client);
  const brokers = await brokerObjects(client);
  const counts: Record<string, KindCount> = {
    topic: topics.capped
      ? { count: topics.rows.length, sampledFrom: TOPIC_CAP_SENTENCE }
      : { count: topics.rows.length },
    consumer_group: { unavailable: KAFKA_AGENT_WITHHELD.groups },
    broker: { count: brokers.length },
  };
  // In the declared order, so a reader walks the kinds as the editor's handle answers them.
  return Object.fromEntries(KAFKA_OBJECT_KINDS.map((kind) => [kind.id, counts[kind.id]]));
}

/**
 * Health on an agent-mode handle: one forced Metadata read proves a broker answers, and the size on disk, which needs
 * the log directories, is its reason rather than a figure.
 */
export async function agentHealth(client: KafkaAgentReadClient): Promise<HealthInfo> {
  await client.metadata([]);
  return { databaseSize: KAFKA_AGENT_WITHHELD.logDirs, cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}
