/**
 * What an agent's Kafka read request sends and answers: the reader of one request, read before anything is sent, and
 * each read of its closed table run over the agent's client, which holds the Metadata and ListOffsets reads alone,
 * with its answer projected to names, counts and flags, and the wording of a failure without the broker's words.
 *
 * The reader (`readKafkaAgentStatement`) is pure. A request is one JSON object of at most four keys, `read`, `topic`,
 * `after` and `limit`, each written once, and `read` names one of four metadata reads: the topic listing, the broker
 * listing, one topic's partitions and one topic's per-partition earliest and end offsets. Each maps to a fixed plan
 * (`KafkaAgentPlan`), so no other field the request writes reaches the wire: the provider sends a Metadata request
 * whose auto-creation flag is the literal false and a ListOffsets request with the earliest (-2) and latest (-1)
 * sentinels, and nothing else. Every refusal is agent mode's own sentence with the list of reads, and none quotes the
 * request: a key, a name or a value it wrote never comes back. The agent's admission of the same request is the
 * request form Kafka's declaration states as data, and tests/helpers/declared-language-census.ts holds the two to the
 * same answer, code and sentence, over a corpus.
 *
 * Metadata only. Topic names, partition ids, broker node ids and racks and the cluster id are object names; a record's
 * key, value, headers and timestamp are stored values, so no read here fetches a record, and no read filters, counts or
 * looks up by time or by a value: a record's timestamp can be the producer's own, and a lookup by time would bisect
 * stored timestamps. Consumer groups, topic and broker configs and log directories stay off the agent's path, and a
 * broker's host and port are never answered. The cursor `after` is compared in Studio against names and ids the
 * broker already answered, and is never sent.
 *
 * The reader is not the boundary. The boundary is the provider's structural closed table: the agent's reads reach the
 * client only through `KafkaAgentReadClient` (`./client.ts`), which holds the Metadata and ListOffsets reads alone, as
 * tests/unit/db/kafka/seam-guard.test.ts pins. The reader is what lets the model read why it was refused, before
 * anything is sent.
 *
 * Each operation has a typed projection here, and the capability `metadataOnly` states them. No column's name comes
 * from the broker, and no answer is passed on as it came: a broker is its node id, rack and the cluster id, never its
 * advertised host and port; a partition is its id, its leader's and replicas' node ids and an offline flag; an offset
 * read is each partition's earliest and end offsets and the span between them, which is not a message count, since
 * compaction, transaction markers and retention all make the two differ. A cell that does not fit its column's kind
 * refuses the whole answer, as a stored value smuggled into a metadata field would look.
 *
 * Budgets refuse rather than cut: the limit is checked against the row budget before anything is sent (`index.ts`),
 * and the byte budget against the projected rows here. A limit the request wrote below the answer's size is the
 * request's own page, so the answer says that more follow, and how to read on, without naming what follows.
 */
import { ByteBudgetRefusal, QueryError, TimeBudgetRefusal } from "@/lib/db/errors";
import { byteBudgetSentence, measureResultBytes, TIME_BUDGET_PREFIX } from "@/lib/db/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { ColumnSchema, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import { repeatsAKey } from "@/lib/db/utils/json-repeated-key";
import {
  type KafkaAgentReadClient,
  KafkaError,
  type KafkaErrorCategory,
  type KafkaPartitionMetadata,
  type KafkaTopicMetadata,
} from "./client";

export type KafkaAgentRefusalCode = "request" | "metadata-only";

/** The metadata operations, each one row of the table and one projection of the answer. */
export type KafkaAgentOperation = "topics" | "brokers" | "partitions" | "offsets";

/** One read the agent may send, with the cursor and limit Studio applies to what the broker answered. */
export type KafkaAgentPlan =
  | { readonly op: "topics"; readonly after?: string; readonly limit: number }
  | { readonly op: "brokers"; readonly after?: number; readonly limit: number }
  | { readonly op: "partitions" | "offsets"; readonly topic: string; readonly after?: number; readonly limit: number };

export type KafkaAgentReading =
  | { readonly ok: true; readonly plan: KafkaAgentPlan }
  | { readonly ok: false; readonly code: KafkaAgentRefusalCode; readonly message: string };

/** How many rows a read answers when the request names no limit. */
export const KAFKA_AGENT_DEFAULT_LIMIT = 50;
/** The largest limit a read takes; the run's row budget may hold it lower, which the provider checks. */
export const KAFKA_AGENT_MAX_LIMIT = 500;

/** Kafka's own legal topic name: 1 to 249 of these characters, other than "." and "..". */
const KAFKA_TOPIC_NAME = /^[a-zA-Z0-9._-]{1,249}$/;
const KAFKA_RESERVED_TOPIC_NAMES: ReadonlySet<string> = new Set([".", ".."]);
/**
 * Kafka's internal topics (Topic.isInternal in 4.3.1), matched whole and by case: a broker before 2.8 creates a missing
 * one for any Metadata request that names it, whatever the auto-creation flag says, so none is ever named.
 */
const KAFKA_INTERNAL_TOPICS: ReadonlySet<string> = new Set([
  "__consumer_offsets",
  "__transaction_state",
  "__share_group_state",
]);
/**
 * A platform's own topics, by the names their platforms give them: a leading underscore (Schema Registry's
 * `_schemas`, Confluent's `_confluent-*`, ksqlDB's command topics, Redpanda's own), or `connect-`, Kafka Connect's
 * configs, offsets and status topics. The broker marks none of them internal, so its listing answers them to any
 * principal that may describe them; they hold connector configs, schemas and offsets rather than the cluster's data,
 * so every agent-mode read withholds them: the listings drop them, and a request that names one is refused. A
 * platform that names its topics otherwise is not recognised; the principal's own Describe grants are what keep those
 * out.
 */
export function isWithheldKafkaTopic(name: string): boolean {
  return name.startsWith("_") || name.startsWith("connect-");
}

/** A partition id and a broker node id are INT32 on the wire. */
const KAFKA_MAX_ID = 2147483647;

const KEYS: ReadonlySet<string> = new Set(["read", "topic", "after", "limit"]);
const READS: ReadonlySet<string> = new Set<KafkaAgentOperation>(["topics", "brokers", "partitions", "offsets"]);

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  'Agent mode on Kafka reads metadata only, one JSON object per read: {"read": "topics"} lists topics with their partition and replica counts, {"read": "brokers"} lists broker node ids and racks, {"read": "partitions", "topic": "orders"} lists one topic\'s partitions with their leader and replicas, and {"read": "offsets", "topic": "orders"} answers each partition\'s earliest and end offsets; each also takes "limit" (1 to 500, default 50) and "after", the last topic name, node id or partition id of the answer before, to read on.';

export const KAFKA_AGENT_SENTENCES = {
  empty: `The request holds no read. ${AGENT_READS} ${NOTHING_SENT}`,
  notObject: `A Kafka agent read is one JSON object. ${AGENT_READS} ${NOTHING_SENT}`,
  repeated: `The request writes a key twice. ${AGENT_READS} ${NOTHING_SENT}`,
  keys: `The request holds a key agent mode does not read: its keys are read, topic, after and limit, so no timestamp, offset sentinel, isolation level, partition filter, group or auto-creation flag can be written. ${AGENT_READS} ${NOTHING_SENT}`,
  notARead: `That is not one of agent mode's reads: a record's key, value, headers and timestamp, consumer groups, configs and log directories are withheld, so no fetch, produce, group, config, log-directory or administrative call is sent. ${AGENT_READS} ${NOTHING_SENT}`,
  topicRequired: `This read names one topic in "topic". ${AGENT_READS} ${NOTHING_SENT}`,
  topicNotTaken: `This read lists the whole cluster and takes no "topic". ${AGENT_READS} ${NOTHING_SENT}`,
  topicName: `"topic" must be a Kafka topic name: 1 to 249 of the characters a-z, A-Z, 0-9, ".", "_" and "-", other than "." and "..". ${AGENT_READS} ${NOTHING_SENT}`,
  internal: `That is one of Kafka's internal topics, which agent mode never names in a request. ${AGENT_READS} ${NOTHING_SENT}`,
  platform: `That topic's name marks it as a platform's own (a leading underscore, as Schema Registry's and Confluent's topics have, or connect-, as Kafka Connect's have), so agent mode withholds it: it is never listed or named in a request. ${AGENT_READS} ${NOTHING_SENT}`,
  limit: `"limit" must be a whole number from 1 to ${KAFKA_AGENT_MAX_LIMIT}. ${AGENT_READS} ${NOTHING_SENT}`,
  topicCursor: `"after" on the topic listing is the last topic name of the answer before, a Kafka topic name. ${AGENT_READS} ${NOTHING_SENT}`,
  idCursor: `"after" on this read is the last node id or partition id of the answer before, a whole number from 0 to ${KAFKA_MAX_ID}. ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: KafkaAgentRefusalCode, message: string): KafkaAgentReading {
  return { ok: false, code, message };
}

const isTopicName = (value: unknown): value is string =>
  typeof value === "string" && KAFKA_TOPIC_NAME.test(value) && !KAFKA_RESERVED_TOPIC_NAMES.has(value);

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= KAFKA_MAX_ID;

/** One agent read request read to the plan the provider sends, or to why it sends nothing. Never sends anything. */
export function readKafkaAgentStatement(text: string): KafkaAgentReading {
  if (text.trim() === "") return refuse("request", KAFKA_AGENT_SENTENCES.empty);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse's own message is not repeated: under Node it quotes the start of the text.
    return refuse("request", KAFKA_AGENT_SENTENCES.notObject);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("request", KAFKA_AGENT_SENTENCES.notObject);
  }
  if (repeatsAKey(text)) return refuse("request", KAFKA_AGENT_SENTENCES.repeated);
  const request = parsed as Record<string, unknown>;
  if (Object.keys(request).some((key) => !KEYS.has(key))) return refuse("request", KAFKA_AGENT_SENTENCES.keys);

  const { read, topic, after, limit: written } = request;
  if (typeof read !== "string" || !READS.has(read)) return refuse("metadata-only", KAFKA_AGENT_SENTENCES.notARead);
  const op = read as KafkaAgentOperation;

  // `=== undefined`, not `??`: a `"limit": null` is a wrong type to refuse, not a default to supply.
  const limit = written === undefined ? KAFKA_AGENT_DEFAULT_LIMIT : written;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > KAFKA_AGENT_MAX_LIMIT) {
    return refuse("request", KAFKA_AGENT_SENTENCES.limit);
  }
  const bound = { limit: limit as number };

  if (op === "topics" || op === "brokers") {
    if (topic !== undefined) return refuse("request", KAFKA_AGENT_SENTENCES.topicNotTaken);
    if (op === "topics") {
      if (after !== undefined && !isTopicName(after)) return refuse("request", KAFKA_AGENT_SENTENCES.topicCursor);
      return { ok: true, plan: { op, ...(after === undefined ? {} : { after }), ...bound } };
    }
    if (after !== undefined && !isId(after)) return refuse("request", KAFKA_AGENT_SENTENCES.idCursor);
    return { ok: true, plan: { op, ...(after === undefined ? {} : { after }), ...bound } };
  }

  if (topic === undefined) return refuse("request", KAFKA_AGENT_SENTENCES.topicRequired);
  if (!isTopicName(topic)) return refuse("request", KAFKA_AGENT_SENTENCES.topicName);
  if (KAFKA_INTERNAL_TOPICS.has(topic)) return refuse("request", KAFKA_AGENT_SENTENCES.internal);
  if (isWithheldKafkaTopic(topic)) return refuse("metadata-only", KAFKA_AGENT_SENTENCES.platform);
  if (after !== undefined && !isId(after)) return refuse("request", KAFKA_AGENT_SENTENCES.idCursor);
  return { ok: true, plan: { op, topic, ...(after === undefined ? {} : { after }), ...bound } };
}

const KAFKA_TYPE = "kafka";

/** One broker as the agent reads it: never its host or port. */
export interface KafkaAgentBroker {
  readonly nodeId: number;
  readonly rack: string | null;
  readonly clusterId: string;
}

/** One partition's earliest and end offsets; a side the broker did not answer is absent, never 0. */
export interface KafkaAgentPartitionOffsets {
  readonly partition: number;
  readonly earliest?: bigint;
  readonly end?: bigint;
}

/** One answer of the table's reads, before projection, and whether the request's limit left rows unread. */
export type KafkaAgentAnswer =
  | { readonly op: "topics"; readonly topics: readonly KafkaTopicMetadata[]; readonly more: boolean }
  | { readonly op: "brokers"; readonly brokers: readonly KafkaAgentBroker[]; readonly more: boolean }
  | { readonly op: "partitions"; readonly partitions: readonly KafkaPartitionMetadata[]; readonly more: boolean }
  | { readonly op: "offsets"; readonly offsets: readonly KafkaAgentPartitionOffsets[]; readonly more: boolean };

/** A bigint as a number where one holds it exactly; anything else is left as it is, which the count kind refuses. */
function countOf(value: bigint | undefined): unknown {
  if (value === undefined) return null;
  // A number that rounds back to the same bigint holds it exactly; the count kind then checks it is a safe integer.
  const number = Number(value);
  return BigInt(number) === value ? number : value;
}

/** Node ids as one name, "1,2,3"; none is null, so an empty list is never read as a name. */
const nodeIds = (ids: readonly number[]): string | null => (ids.length === 0 ? null : ids.join(","));

const TOPICS: MetadataProjection<KafkaTopicMetadata> = [
  { column: "topic", kind: "name", read: (t) => t.name },
  { column: "partitions", kind: "count", read: (t) => t.partitions.length },
  {
    column: "replication_factor",
    kind: "count",
    read: (t) => t.partitions.reduce((most, p) => Math.max(most, p.replicas.length), 0),
  },
  { column: "offline_partitions", kind: "count", read: (t) => t.partitions.filter((p) => p.leader < 0).length },
  {
    column: "under_replicated_partitions",
    kind: "count",
    read: (t) => t.partitions.filter((p) => p.isr.length < p.replicas.length).length,
  },
];

const BROKERS: MetadataProjection<KafkaAgentBroker> = [
  { column: "node_id", kind: "count", read: (b) => b.nodeId },
  { column: "rack", kind: "name", optional: true, read: (b) => b.rack },
  // A cluster id the broker did not give is answered null, never "".
  { column: "cluster_id", kind: "name", optional: true, read: (b) => (b.clusterId === "" ? null : b.clusterId) },
];

const PARTITIONS: MetadataProjection<KafkaPartitionMetadata> = [
  { column: "partition", kind: "count", read: (p) => p.partition },
  // -1 is the protocol's "no leader", which is null here, and `offline` says so.
  { column: "leader", kind: "count", optional: true, read: (p) => (p.leader < 0 ? null : p.leader) },
  { column: "replicas", kind: "name", optional: true, read: (p) => nodeIds(p.replicas) },
  { column: "in_sync_replicas", kind: "name", optional: true, read: (p) => nodeIds(p.isr) },
  { column: "offline_replicas", kind: "name", optional: true, read: (p) => nodeIds(p.offlineReplicas) },
  { column: "offline", kind: "flag", read: (p) => p.leader < 0 },
];

const OFFSETS: MetadataProjection<KafkaAgentPartitionOffsets> = [
  { column: "partition", kind: "count", read: (o) => o.partition },
  { column: "earliest_offset", kind: "count", optional: true, read: (o) => countOf(o.earliest) },
  { column: "end_offset", kind: "count", optional: true, read: (o) => countOf(o.end) },
  {
    column: "offset_span",
    kind: "count",
    optional: true,
    read: (o) => (o.earliest === undefined || o.end === undefined ? null : countOf(o.end - o.earliest)),
  },
];

const PROJECTIONS = Object.freeze({
  topics: TOPICS,
  brokers: BROKERS,
  partitions: PARTITIONS,
  offsets: OFFSETS,
} satisfies Record<KafkaAgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for Kafka: every operation's columns and their kinds. */
export const KAFKA_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/**
 * A topic's columns as an agent-mode handle describes them: the offset read's, so the grounding names the columns an
 * agent read answers and never the editor's record cells (key, value, headers, timestamp).
 */
export const KAFKA_AGENT_TOPIC_COLUMNS: readonly ColumnSchema[] = Object.freeze(
  OFFSETS.map(({ column, optional }) =>
    Object.freeze({ name: column, type: "integer", nullable: optional === true, isPrimary: false }),
  ),
);

/** The rows after `after`, at most `limit` of them, and whether the limit left any unread. */
function page<T>(rows: readonly T[], limit: number): { readonly rows: readonly T[]; readonly more: boolean } {
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** The partitions after the request's cursor, in id order. */
const afterPartition = <T extends { readonly partition: number }>(rows: readonly T[], after: number | undefined) =>
  [...rows].sort((a, b) => a.partition - b.partition).filter((row) => after === undefined || row.partition > after);

/**
 * The raw answer of one admitted read, through the agent's client alone. The topic listing reads every name with one
 * Metadata request and then the listed page's topics with another, both with auto-creation off; a broker read is a
 * brokers-only Metadata request; a partition read is one Metadata request naming the topic; an offset read is that
 * Metadata request and two ListOffsets requests, at the earliest and at the latest sentinel (the log end). The cursor
 * and the limit are applied here, to what the broker answered, and never sent.
 */
async function answerOf(client: KafkaAgentReadClient, plan: KafkaAgentPlan): Promise<KafkaAgentAnswer> {
  switch (plan.op) {
    case "topics": {
      const names = (await client.listTopics()).filter((name) => plan.after === undefined || name > plan.after);
      const chosen = page(names, plan.limit);
      if (chosen.rows.length === 0) return { op: "topics", topics: [], more: false };
      const { topics } = await client.metadata(chosen.rows);
      return { op: "topics", topics, more: chosen.more };
    }
    case "brokers": {
      const { clusterId, brokers } = await client.metadata([]);
      const listed = [...brokers]
        .sort((a, b) => a.nodeId - b.nodeId)
        .filter((b) => plan.after === undefined || b.nodeId > plan.after)
        .map(({ nodeId, rack }): KafkaAgentBroker => ({ nodeId, rack, clusterId }));
      const chosen = page(listed, plan.limit);
      return { op: "brokers", brokers: chosen.rows, more: chosen.more };
    }
    case "partitions": {
      const [topic] = (await client.metadata([plan.topic])).topics;
      const chosen = page(afterPartition(topic?.partitions ?? [], plan.after), plan.limit);
      return { op: "partitions", partitions: chosen.rows, more: chosen.more };
    }
    case "offsets": {
      const [topic] = (await client.metadata([plan.topic])).topics;
      const partitions = afterPartition(topic?.partitions ?? [], plan.after);
      const chosen = page(partitions, plan.limit);
      // A cursor past the last partition reads nothing more, so no ListOffsets is sent for it.
      if (chosen.rows.length === 0) return { op: "offsets", offsets: [], more: false };
      const earliest = await client.offsets(plan.topic, "earliest");
      const end = await client.offsets(plan.topic, "high-watermark");
      const offsets = chosen.rows.map(({ partition }): KafkaAgentPartitionOffsets => {
        const first = earliest.get(partition);
        const last = end.get(partition);
        return {
          partition,
          ...(first === undefined ? {} : { earliest: first }),
          ...(last === undefined ? {} : { end: last }),
        };
      });
      return { op: "offsets", offsets, more: chosen.more };
    }
  }
}

/** The deadline's own failure, so the wording can tell it from the broker's timeout. */
class AgentDeadlineError extends Error {}

/**
 * One admitted read under the deadline `deadlineMs`. A deadline ends the wait, not the work: a request already sent is
 * left to settle under the client's own timers, and its answer is dropped.
 */
export async function runKafkaAgentRead(
  client: KafkaAgentReadClient,
  plan: KafkaAgentPlan,
  deadlineMs: number,
): Promise<KafkaAgentAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentDeadlineError()), deadlineMs);
  });
  const read = answerOf(client, plan);
  // The read's own rejection after the deadline won is observed here, so it is never an unhandled one.
  read.catch(() => undefined);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const MORE: Readonly<Record<KafkaAgentOperation, string>> = Object.freeze({
  topics: 'More topics follow this answer: read on with "after" set to the last topic of this answer.',
  brokers: 'More brokers follow this answer: read on with "after" set to the last node id of this answer.',
  partitions: 'More partitions follow this answer: read on with "after" set to the last partition of this answer.',
  offsets: 'More partitions follow this answer: read on with "after" set to the last partition of this answer.',
});

/** The rows of one answer under its operation's projection. */
function project(answer: KafkaAgentAnswer): ReturnType<typeof projectMetadata> {
  switch (answer.op) {
    case "topics":
      return projectMetadata(TOPICS, answer.topics);
    case "brokers":
      return projectMetadata(BROKERS, answer.brokers);
    case "partitions":
      return projectMetadata(PARTITIONS, answer.partitions);
    case "offsets":
      return projectMetadata(OFFSETS, answer.offsets);
  }
}

/** The answer of one read: its projected rows, refused past the byte budget rather than cut. */
export function kafkaAgentResult(
  answer: KafkaAgentAnswer,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const projected = project(answer);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new ByteBudgetRefusal(byteBudgetSentence(bytes, budget.maxResultBytes), KAFKA_TYPE, statement);
  }
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime,
    ...(answer.more ? { warnings: [{ message: MORE[answer.op] }] } : {}),
  };
}

const NOT_PASSED_ON = "The broker's own words are not passed on to agent mode, since they can name a broker's address.";

const UNREADABLE_ANSWER = (category: KafkaErrorCategory) =>
  `The broker's answer to the read could not be read as metadata (${category}). ${NOT_PASSED_ON}`;

const UNREACHABLE = `The broker could not be reached for the read. ${NOT_PASSED_ON}`;

/** The wording of each failure the agent reads, by the client's category alone. */
const FAILURES: Readonly<Record<KafkaErrorCategory, (deadlineMs: number) => string>> = Object.freeze({
  "unknown-topic": () =>
    `The topic does not exist. Nothing was created: an agent read asks the broker never to create a topic. ${NOT_PASSED_ON}`,
  "unreadable-topic": () =>
    `A partition of the topic has no leader, so its offsets cannot be read until every partition has one; its partitions can still be read. ${NOT_PASSED_ON}`,
  authorization: () => `The broker refused this connection's principal the read. ${NOT_PASSED_ON}`,
  authentication: () => `The broker did not accept this connection's credentials. ${NOT_PASSED_ON}`,
  tls: () => UNREACHABLE,
  network: () => UNREACHABLE,
  "advertised-unreachable": () => UNREACHABLE,
  timeout: (deadlineMs) => `${TIME_BUDGET_PREFIX}: no answer within ${deadlineMs}ms`,
  "invalid-request": () => UNREADABLE_ANSWER("invalid-request"),
  "invalid-config": () => UNREADABLE_ANSWER("invalid-config"),
  "unknown-object": () => UNREADABLE_ANSWER("unknown-object"),
  "offset-out-of-range": () => UNREADABLE_ANSWER("offset-out-of-range"),
  "unsupported-broker": () => UNREADABLE_ANSWER("unsupported-broker"),
  protocol: () => UNREADABLE_ANSWER("protocol"),
});

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is (a defect of ours). A Kafka
 * failure is worded by its category alone, never by its message, which can carry an advertised host and port; the
 * deadline is the time budget's refusal, and an answer that fits no column is the projection's own sentence.
 */
export function kafkaAgentFailure(error: unknown, deadlineMs: number, statement?: string): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, KAFKA_TYPE, statement);
  if (error instanceof AgentDeadlineError) {
    return new TimeBudgetRefusal(FAILURES.timeout(deadlineMs), KAFKA_TYPE, statement);
  }
  if (error instanceof KafkaError && error.category === "timeout") {
    return new TimeBudgetRefusal(FAILURES.timeout(deadlineMs), KAFKA_TYPE, statement);
  }
  if (error instanceof KafkaError) return new QueryError(FAILURES[error.category](deadlineMs), KAFKA_TYPE, statement);
  return undefined;
}
