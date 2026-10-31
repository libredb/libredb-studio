/**
 * The agent's reader of one Kafka read request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. A request is one JSON object of at most four keys, `read`, `topic`, `after` and `limit`, each written once, and
 * `read` names one of four metadata reads: the topic listing, the broker listing, one topic's partitions and one
 * topic's per-partition earliest and end offsets. Each maps to a fixed plan (`KafkaAgentPlan`), so no other field the
 * request writes reaches the wire: the provider sends a Metadata request whose auto-creation flag is the literal false
 * and a ListOffsets request with the earliest (-2) and latest (-1) sentinels, and nothing else. Every refusal is agent
 * mode's own sentence with the list of reads, and none quotes the request: a key, a name or a value it wrote never
 * comes back.
 *
 * Metadata only. Topic names, partition ids, broker node ids and racks and the cluster id are object names; a record's
 * key, value, headers and timestamp are stored values, so no read here fetches a record, and no read filters, counts or
 * looks up by time or by a value: a record's timestamp can be the producer's own, and a lookup by time would bisect
 * stored timestamps. Consumer groups, topic and broker configs and log directories stay off the agent's path, and a
 * broker's host and port are never answered. The cursor `after` is compared in Studio against names and ids the
 * broker already answered, and is never sent.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the agent's reads reach the client only
 * through `KafkaAgentReadClient` (`client.ts`), which holds the Metadata and ListOffsets reads alone, as
 * tests/unit/db/kafka/seam-guard.test.ts pins. This is what lets the model read why it was refused, before anything is
 * sent.
 */

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
  limit: `"limit" must be a whole number from 1 to ${KAFKA_AGENT_MAX_LIMIT}. ${AGENT_READS} ${NOTHING_SENT}`,
  topicCursor: `"after" on the topic listing is the last topic name of the answer before, a Kafka topic name. ${AGENT_READS} ${NOTHING_SENT}`,
  idCursor: `"after" on this read is the last node id or partition id of the answer before, a whole number from 0 to ${KAFKA_MAX_ID}. ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: KafkaAgentRefusalCode, message: string): KafkaAgentReading {
  return { ok: false, code, message };
}

/**
 * Whether a key is written twice in the one object `text` holds, which JSON.parse has already accepted as one object
 * of scalars and nested values: the scan tells keys from values by the object they sit in, and decodes each key's
 * spelling as JSON does, so `"topic"` is `topic`.
 */
function repeatsAKey(text: string): boolean {
  const open: { readonly keys: Set<string> | null; expectsKey: boolean }[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "{" || char === "[") open.push({ keys: char === "{" ? new Set() : null, expectsKey: char === "{" });
    else if (char === "}" || char === "]") open.pop();
    else if (char === ",") {
      const top = open.at(-1) as { readonly keys: Set<string> | null; expectsKey: boolean };
      top.expectsKey = top.keys !== null;
    } else if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = open.at(-1);
      if (top?.keys && top.expectsKey) {
        const key = JSON.parse(text.slice(at, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectsKey = false;
      }
      at = end;
    }
  }
  return false;
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
  if (after !== undefined && !isId(after)) return refuse("request", KAFKA_AGENT_SENTENCES.idCursor);
  return { ok: true, plan: { op, topic, ...(after === undefined ? {} : { after }), ...bound } };
}
