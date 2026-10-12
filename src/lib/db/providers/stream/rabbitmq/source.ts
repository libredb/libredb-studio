/**
 * The detail of a queue, a stream or an exchange as labelled JSON parts, read from the management API.
 *
 * Only the fields Studio shows reach a part: per consumer six fields and no tag, channel, peer or argument; no owner,
 * no delivery or incoming statistics, and no user who last changed the object. Node names (node, leader, members,
 * online) are shown in this detail only, which no machine surface reads for this provider.
 *
 * A queue's messages are never read: its "Messages" part is a statement that says why. When the broker lists the
 * rabbitmq_stream_management plugin, one tracking GET says whether this account could take the queue's messages,
 * and an "Access" statement says so. A part the account may not read carries the permissions sentence instead.
 */
import { applySourceBound } from "@/lib/db/object-kinds";
import type { ObjectSourceDocument, ObjectSourcePart, ProviderCapabilities } from "@/lib/db/types";
import {
  countsLabel,
  QUEUE_COUNTS_NOTE,
  QUEUE_MESSAGES_STATEMENT,
  readableQueuesCaution,
  STREAM_COUNTS_NOTE,
  VhostAccessError,
} from "./errors";
import type { BindingsAnswer, ManagementClient, PolicyRow, QueueDetail } from "./management/client";
import { requireObjectPath } from "./objects";
import type { TrackingProbe } from "./tracking-probe";

export interface SourceReaders {
  readonly client: ManagementClient;
  readonly tracking: TrackingProbe;
  readonly capabilities: ProviderCapabilities;
  /** Milliseconds since the epoch, for the counts' sample time. */
  readonly now: () => number;
}

const SUPER_STREAM = "x-super-stream";
const PARTITION_ORDER = "x-stream-partition-order";

const json = (value: unknown) => JSON.stringify(value, null, 2);

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

const statement = (id: string, label: string, sentence: string): ObjectSourcePart => ({
  id,
  label,
  unavailable: sentence,
  statement: true,
});

/** A part's read: its answer, or the permissions sentence when the account may not read it; any other failure throws. */
async function partRead<T>(read: () => Promise<T>): Promise<{ readonly answer: T } | { readonly refused: string }> {
  try {
    return { answer: await read() };
  } catch (error) {
    if (error instanceof VhostAccessError) return { refused: error.message };
    throw error;
  }
}

function partFrom<T>(
  id: string,
  label: string,
  read: { readonly answer: T } | { readonly refused: string },
  render: (answer: T) => unknown,
  limit: number | undefined,
): ObjectSourcePart {
  return "refused" in read ? { id, label, unavailable: read.refused } : part(id, label, render(read.answer), limit);
}

function bindingsValue(answer: BindingsAnswer): unknown {
  const rows = answer.rows.map((row) => ({
    source: row.source,
    destination: row.destination,
    destination_type: row.destinationType,
    routing_key: row.routingKey,
    arguments: row.arguments,
  }));
  return answer.total === rows.length ? rows : { bindings: rows, not_kept: answer.total - rows.length };
}

function policyNamed(rows: readonly PolicyRow[] | undefined, name: string | null): unknown {
  if (name === null) return null;
  const found = rows?.find((row) => row.name === name);
  return found === undefined
    ? name
    : {
        name: found.name,
        pattern: found.pattern,
        apply_to: found.applyTo,
        definition: found.definition,
        priority: found.priority,
      };
}

function queueValue(
  detail: QueueDetail,
  policies: readonly PolicyRow[] | undefined,
  operatorPolicies: readonly PolicyRow[] | undefined,
): unknown {
  const effective = detail.effectivePolicyDefinition;
  return {
    type: detail.type,
    durable: detail.durable,
    auto_delete: detail.autoDelete,
    exclusive: detail.exclusive,
    arguments: detail.arguments,
    policy: policyNamed(policies, detail.policy),
    operator_policy: policyNamed(operatorPolicies, detail.operatorPolicy),
    effective_policy_definition: effective,
    delivery_limit: detail.deliveryLimit,
    dead_letter_exchange: detail.arguments["x-dead-letter-exchange"] ?? effective["dead-letter-exchange"] ?? null,
    dead_letter_routing_key:
      detail.arguments["x-dead-letter-routing-key"] ?? effective["dead-letter-routing-key"] ?? null,
    state: detail.state,
    node: detail.node,
    leader: detail.leader,
    members: detail.members,
    online: detail.online,
  };
}

function consumersValue(detail: QueueDetail): unknown {
  return {
    count: detail.consumers,
    consumers: detail.consumerDetails.map((consumer) => ({
      exclusive: consumer.exclusive,
      ack_required: consumer.ackRequired,
      prefetch_count: consumer.prefetchCount,
      active: consumer.active,
      activity_status: consumer.activityStatus,
      consumer_timeout: consumer.consumerTimeout,
    })),
  };
}

async function queueOrStreamSource(
  readers: SourceReaders,
  path: readonly string[],
  kind: "queue" | "stream",
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const [vhost, name] = path;
  const { client } = readers;
  const [detail, policies, operatorPolicies] = await Promise.all([
    client.get("queue", { vhost, name }),
    partRead(() => client.get("policies", { vhost })),
    partRead(() => client.get("operator-policies", { vhost })),
  ]);
  const sampledAt = new Date(readers.now()).toISOString();
  const bindings = await partRead(() => client.get("queue-bindings", { vhost, name }));
  const answerOf = <T>(read: { readonly answer: T } | { readonly refused: string }) =>
    "answer" in read ? read.answer : undefined;
  const parts: [ObjectSourcePart, ...ObjectSourcePart[]] = [
    part(
      kind,
      kind === "stream" ? "Stream" : "Queue",
      queueValue(detail, answerOf(policies), answerOf(operatorPolicies)),
      limit,
    ),
    part(
      "counts",
      countsLabel(sampledAt),
      {
        messages: detail.messages,
        messages_ready: detail.messagesReady,
        messages_unacknowledged: detail.messagesUnacknowledged,
        consumers: detail.consumers,
        note: kind === "stream" ? STREAM_COUNTS_NOTE : QUEUE_COUNTS_NOTE,
      },
      limit,
    ),
    partFrom("bindings", "Bindings", bindings, bindingsValue, limit),
    part("consumers", "Consumers", consumersValue(detail), limit),
  ];
  if (kind === "queue") {
    parts.push(statement("messages", "Messages", QUEUE_MESSAGES_STATEMENT));
    if (await readers.tracking.streamManagementListed()) {
      const access = await readers.tracking.queueReadableByAccount(vhost, name);
      if (access === "readable") parts.push(statement("access", "Access", readableQueuesCaution(vhost, [name], 0, 0)));
    }
  }
  return { path, kind, parts };
}

async function exchangeSource(
  readers: SourceReaders,
  path: readonly string[],
  limit: number | undefined,
): Promise<ObjectSourceDocument> {
  const [vhost, name] = path;
  const { client } = readers;
  const detail = await client.get("exchange", { vhost, name });
  // One bindings answer at a time: the destination GET starts after the source GET ended.
  const source = await partRead(() => client.get("exchange-bindings-source", { vhost, name }));
  const destination = await partRead(() => client.get("exchange-bindings-destination", { vhost, name }));
  const parts: [ObjectSourcePart, ...ObjectSourcePart[]] = [
    part(
      "exchange",
      "Exchange",
      {
        type: detail.type,
        durable: detail.durable,
        auto_delete: detail.autoDelete,
        internal: detail.internal,
        arguments: detail.arguments,
        policy: detail.policy,
      },
      limit,
    ),
    partFrom("bindings-source", "Bindings (as source)", source, bindingsValue, limit),
    partFrom("bindings-destination", "Bindings (as destination)", destination, bindingsValue, limit),
  ];
  if (detail.arguments[SUPER_STREAM] === true && "answer" in source) {
    const partitions = source.answer.rows
      .filter((row) => typeof row.arguments[PARTITION_ORDER] === "number")
      .map((row) => ({
        order: row.arguments[PARTITION_ORDER] as number,
        stream: row.destination,
        routing_key: row.routingKey,
      }))
      .sort((a, b) => a.order - b.order);
    parts.push(part("partitions", "Super stream partitions", partitions, limit));
  }
  return { path, kind: "exchange", parts };
}

/** The detail document of one object; the path is [virtual host, name]. */
export async function readSource(
  readers: SourceReaders,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  requireObjectPath(readers.capabilities, path, kind);
  if (kind === "exchange") return exchangeSource(readers, path, limit);
  return queueOrStreamSource(readers, path, kind as "queue" | "stream", limit);
}
