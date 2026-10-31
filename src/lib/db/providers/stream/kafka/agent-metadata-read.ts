/**
 * What an agent's Kafka read sends and answers: each read of the closed table (`agent-statement.ts`) run over the
 * agent's client, which holds the Metadata and ListOffsets reads alone, and its answer projected to names, counts and
 * flags, with the wording of a failure without the broker's words.
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
import { QueryError } from "@/lib/db/errors";
import { byteBudgetSentence, measureResultBytes, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { ColumnSchema, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { KafkaAgentOperation, KafkaAgentPlan } from "./agent-statement";
import {
  type KafkaAgentReadClient,
  KafkaError,
  type KafkaErrorCategory,
  type KafkaPartitionMetadata,
  type KafkaTopicMetadata,
} from "./client";

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
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), KAFKA_TYPE, statement);
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
  if (error instanceof AgentDeadlineError) return new QueryError(FAILURES.timeout(deadlineMs), KAFKA_TYPE, statement);
  if (error instanceof KafkaError) return new QueryError(FAILURES[error.category](deadlineMs), KAFKA_TYPE, statement);
  return undefined;
}
