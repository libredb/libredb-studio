/**
 * What an agent's Sparkplug read sends and answers: each read of the closed table (`agent-statement.ts`) run as one
 * fresh session over the provider's own encoder, its messages counted by message type, and the count projected to
 * numbers, flags and fixed names, with the completeness sentence on every answer and every failure worded by its kind
 * alone.
 *
 * ONE FRESH SESSION PER READ. Each read dials, sends CONNECT with Clean Start and no Will, one SUBSCRIBE (the whole
 * namespace for the window read, the one group for the group read, and for an edge node or a device its own birth,
 * death and data topics written in full), and leaves with UNSUBSCRIBE and DISCONNECT when the window ends: nothing is
 * kept from one read for the next. A read never subscribes to `$sparkplug/` or to host state on its own, and never
 * writes a filter the model wrote.
 *
 * A WINDOW IS NOT A CUT. Sparkplug has no command that lists edge nodes or devices, so a read is what one subscription
 * delivered in one window, and its answer is the window's own totals: how long it listened, what it counted and why
 * it stopped. Studio's message and byte budgets can end a window early, and the answer says so as its stop reason;
 * nothing the read counted is dropped from a figure. What is never claimed is completeness: every answer says that an
 * edge node or device that published nothing in the window may still exist, and none says a node is online or offline.
 *
 * Metadata only, as the capability `metadataOnly` states it: no column's name comes from the broker, no id is
 * answered (an exact read does not echo the id it named), and no metric name, value, property, dataset, template or
 * alias is read into a row: a payload is decoded only to count its metrics, and its contents go nowhere.
 */
import { QueryError } from "@/lib/db/errors";
import { isTlsFailureCode } from "@/lib/db/http/node-transport";
import { byteBudgetSentence, measureResultBytes, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { SparkplugAgentOperation, SparkplugAgentPlan } from "./agent-statement";
import {
  DEFAULT_WINDOW_SECONDS,
  MAX_BYTES_PER_READ,
  MAX_MESSAGES_PER_READ,
  SPARKPLUG_AGENT_MIN_STATEMENT_MS,
  SPARKPLUG_NAMESPACE,
} from "./constants";
import { decodePayload, type DecodedMessage } from "./decode";
import type { SparkplugReadOutcome, SparkplugReadRequest, SparkplugReader } from "./index";
import type { ReceivedMessage } from "./session";
import { type MessageType, type NodeTopic, parseTopic } from "./topics";

const SPARKPLUG_TYPE = "sparkplug";

/** Studio's window for every agent read, in milliseconds. */
const WINDOW_MS = DEFAULT_WINDOW_SECONDS * 1000;

/** The six message types an edge node or device publishes about itself; commands and host state are others'. */
const COUNTED = ["NBIRTH", "NDEATH", "NDATA", "DBIRTH", "DDEATH", "DDATA"] as const;
type CountedType = (typeof COUNTED)[number];

function isCounted(type: MessageType): type is CountedType {
  return (COUNTED as readonly string[]).includes(type);
}

/** What one read counted: totals only, with the ids it saw kept as sets for their sizes and never answered. */
export interface SparkplugAgentTally {
  readonly messages: number;
  readonly byType: Readonly<Record<CountedType, number>>;
  /** Messages outside the six types: host state, commands another client sent, topics outside the namespace's form. */
  readonly other: number;
  readonly metrics: number;
  readonly undecodable: number;
  readonly payloadBytes: number;
  readonly payloadsNotKept: number;
  readonly groups: number;
  readonly edgeNodes: number;
  readonly devices: number;
  readonly lastReceivedAt?: number;
}

/** Whether a message's topic is the object the plan names: the window's is every one. */
function isTarget(plan: SparkplugAgentPlan, topic: NodeTopic): boolean {
  switch (plan.op) {
    case "window":
      return true;
    case "group":
      return topic.groupId === plan.group;
    case "edgeNode":
      return topic.groupId === plan.group && topic.edgeNodeId === plan.edgeNode && topic.deviceId === undefined;
    case "device":
      return topic.groupId === plan.group && topic.edgeNodeId === plan.edgeNode && topic.deviceId === plan.device;
  }
}

/** How many metrics a payload carries: counted, never named or read. */
function metricCount(payload: DecodedMessage): number {
  const { metrics } = payload;
  if (metrics === undefined) return 0;
  return Array.isArray(metrics) ? metrics.length : 1;
}

/**
 * Count one read's messages. The window counts every message it was delivered, the six types by type and the rest as
 * others; an exact read counts the six types of its own object and nothing else, since its subscription names that
 * object. A payload is decoded only to count its metrics; one the decoder refuses is counted as not decodable.
 */
function tallySparkplugMessages(plan: SparkplugAgentPlan, messages: readonly ReceivedMessage[]): SparkplugAgentTally {
  const byType: Record<CountedType, number> = { NBIRTH: 0, NDEATH: 0, NDATA: 0, DBIRTH: 0, DDEATH: 0, DDATA: 0 };
  const groups = new Set<string>();
  const edgeNodes = new Set<string>();
  const devices = new Set<string>();
  let counted = 0;
  let other = 0;
  let metrics = 0;
  let undecodable = 0;
  let payloadBytes = 0;
  let payloadsNotKept = 0;
  let lastReceivedAt: number | undefined;
  for (const message of messages) {
    const topic = parseTopic(message.topic);
    const ownType = topic.kind === "node" && !topic.stored && isCounted(topic.messageType) && isTarget(plan, topic);
    if (!ownType) {
      if (plan.op === "window") {
        counted++;
        other++;
        payloadBytes += message.payloadBytes;
      }
      continue;
    }
    const node = topic as NodeTopic & { readonly messageType: CountedType };
    counted++;
    byType[node.messageType]++;
    payloadBytes += message.payloadBytes;
    lastReceivedAt = Math.max(lastReceivedAt ?? message.receivedAt, message.receivedAt);
    // Keys in JSON so that no id can run into the next: the sets are counted, never read.
    groups.add(JSON.stringify([node.groupId]));
    edgeNodes.add(JSON.stringify([node.groupId, node.edgeNodeId]));
    if (node.deviceId !== undefined) devices.add(JSON.stringify([node.groupId, node.edgeNodeId, node.deviceId]));
    if (message.payload === undefined) {
      payloadsNotKept++;
      continue;
    }
    let payload: DecodedMessage;
    try {
      payload = decodePayload(message.payload);
    } catch {
      // The decoder's words name the bound a payload broke, never its contents, and they are not passed on either.
      undecodable++;
      continue;
    }
    // A death carries its bdSeq and nothing else a reader would call a metric.
    if (!node.messageType.endsWith("DEATH")) metrics += metricCount(payload);
  }
  return {
    messages: counted,
    byType,
    other,
    metrics,
    undecodable,
    payloadBytes,
    payloadsNotKept,
    groups: groups.size,
    edgeNodes: edgeNodes.size,
    devices: devices.size,
    ...(lastReceivedAt === undefined ? {} : { lastReceivedAt }),
  };
}

/**
 * The subscription filters of one plan, every one written by Studio. `scope` is the group the connection names, or
 * empty for every group: the window then listens to that group alone, as the editor's reads do.
 */
export function sparkplugAgentFilters(plan: SparkplugAgentPlan, scope: string): readonly string[] {
  switch (plan.op) {
    case "window":
      return [scope === "" ? `${SPARKPLUG_NAMESPACE}/#` : `${SPARKPLUG_NAMESPACE}/${scope}/#`];
    case "group":
      return [`${SPARKPLUG_NAMESPACE}/${plan.group}/#`];
    case "edgeNode":
      return (["NBIRTH", "NDEATH", "NDATA"] as const).map(
        (type) => `${SPARKPLUG_NAMESPACE}/${plan.group}/${type}/${plan.edgeNode}`,
      );
    case "device":
      return (["DBIRTH", "DDEATH", "DDATA"] as const).map(
        (type) => `${SPARKPLUG_NAMESPACE}/${plan.group}/${type}/${plan.edgeNode}/${plan.device}`,
      );
  }
}

/** One read's answer, before projection. */
export interface SparkplugAgentAnswer {
  readonly plan: SparkplugAgentPlan;
  readonly scoped: boolean;
  readonly outcome: SparkplugReadOutcome;
  readonly tally: SparkplugAgentTally;
}

/** How long the window ran: the read's own clock, which starts before the dial. */
function windowMs(outcome: SparkplugReadOutcome): number {
  return outcome.elapsedMs ?? 0;
}

/** How long the subscription listened: from the SUBSCRIBE to the end of the read, never more than the window. */
function listenedMs(outcome: SparkplugReadOutcome): number {
  return outcome.subscribedAtMs === undefined ? 0 : windowMs(outcome) - outcome.subscribedAtMs;
}

const WINDOW_COLUMNS: MetadataProjection<SparkplugAgentAnswer> = [
  { column: "window_ms", kind: "count", read: (a) => windowMs(a.outcome) },
  { column: "listened_ms", kind: "count", read: (a) => listenedMs(a.outcome) },
  { column: "stop_reason", kind: "name", read: (a) => a.outcome.endReason },
  // Never "complete": Sparkplug gives no way to establish it.
  { column: "scope", kind: "name", read: () => "window" },
  { column: "broker_reason_code", kind: "count", optional: true, read: (a) => a.outcome.refusalCode },
  { column: "subscriptions_refused", kind: "count", read: (a) => a.outcome.subscriptionsRefused ?? 0 },
];

const LOSS_COLUMNS: MetadataProjection<SparkplugAgentAnswer> = [
  { column: "metrics", kind: "count", read: (a) => a.tally.metrics },
  { column: "payload_bytes", kind: "count", read: (a) => a.tally.payloadBytes },
  { column: "messages_not_decodable", kind: "count", read: (a) => a.tally.undecodable },
  { column: "payloads_not_kept", kind: "count", read: (a) => a.tally.payloadsNotKept },
];

/** A type's count, or null on an exact read whose subscription cannot carry that type. */
function typeColumn(type: CountedType): MetadataProjection<SparkplugAgentAnswer>[number] {
  const column = type.toLowerCase();
  const nodeLevel = type.startsWith("N");
  return {
    column,
    kind: "count",
    optional: true,
    read: (a) => {
      if (a.plan.op === "edgeNode" && !nodeLevel) return undefined;
      if (a.plan.op === "device" && nodeLevel) return undefined;
      return a.tally.byType[type];
    },
  };
}

const TYPE_COLUMNS = COUNTED.map(typeColumn);

const WINDOW: MetadataProjection<SparkplugAgentAnswer> = [
  ...WINDOW_COLUMNS,
  { column: "groups_seen", kind: "count", read: (a) => a.tally.groups },
  { column: "edge_nodes_seen", kind: "count", read: (a) => a.tally.edgeNodes },
  { column: "devices_seen", kind: "count", read: (a) => a.tally.devices },
  { column: "messages", kind: "count", read: (a) => a.tally.messages },
  ...TYPE_COLUMNS,
  { column: "other_messages", kind: "count", read: (a) => a.tally.other },
  ...LOSS_COLUMNS,
];

const EXACT: MetadataProjection<SparkplugAgentAnswer> = [
  ...WINDOW_COLUMNS,
  { column: "seen", kind: "flag", read: (a) => a.tally.messages > 0 },
  { column: "messages", kind: "count", read: (a) => a.tally.messages },
  ...TYPE_COLUMNS,
  { column: "birth_seen", kind: "flag", read: (a) => a.tally.byType.NBIRTH + a.tally.byType.DBIRTH > 0 },
  { column: "death_seen", kind: "flag", read: (a) => a.tally.byType.NDEATH + a.tally.byType.DDEATH > 0 },
  // Counted from the subscription, as `listened_ms` is, so the two read on one clock. Not seen, no last message.
  {
    column: "last_seen_ms",
    kind: "count",
    optional: true,
    read: (a) => {
      const last = a.tally.lastReceivedAt;
      if (last === undefined) return undefined;
      return last - (a.outcome.startedAt ?? 0) - (a.outcome.subscribedAtMs ?? 0);
    },
  },
  ...LOSS_COLUMNS,
];

const PROJECTIONS = Object.freeze({
  window: WINDOW,
  group: EXACT,
  edgeNode: EXACT,
  device: EXACT,
} satisfies Record<SparkplugAgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for Sparkplug: every read's columns and their kinds. */
export const SPARKPLUG_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** The sentence every answer carries, and the tool description, the grounding and the posture say the same. */
export const SPARKPLUG_COMPLETENESS =
  "An edge node or device not seen in the window may still exist: Sparkplug has no command that lists edge nodes or devices, a birth certificate is published at QoS 0 and not retained, and an edge node that published nothing in the window looks exactly like one that is gone, so no answer is a complete count of the plant, and no answer says that a node or device is online, offline or absent, only what the window saw.";

/**
 * What an exact read's columns are, said on every exact read, a miss's as a hit's so the two answers keep one shape:
 * `last_seen_ms` is the last message's, while the counts are the window's (the MQTT lesson: a reader who takes a
 * last-message figure for a total misreports both).
 */
export const SPARKPLUG_EXACT_LAST_MESSAGE =
  "last_seen_ms is when the last message from it arrived, counted from the subscription; the message counts, the metrics and the payload bytes are totals over the window, and birth_seen and death_seen say whether the window saw a birth or a death, not whether it is online or offline now.";

/** A count and its noun, singular for one. */
function countOf(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? noun : `${noun}s`}`;
}

/** Why a window stopped, in agent mode's words, for the end reasons an answer is given for. */
const STOP_WORDS: Readonly<Record<string, (outcome: SparkplugReadOutcome) => string>> = Object.freeze({
  "time-budget": () => "the window ended",
  "message-budget": () =>
    `Studio's message budget of ${MAX_MESSAGES_PER_READ.toLocaleString("en-US")} messages was reached before the window ended`,
  "byte-budget": () =>
    `Studio's byte budget of ${(MAX_BYTES_PER_READ * 2).toLocaleString("en-US")} bytes was reached before the window ended`,
  "broker-closed": () => "the broker closed the connection before the window ended",
  "subscription-refused": (outcome) =>
    `the broker refused every subscription${
      outcome.refusalCode === undefined
        ? ""
        : ` with reason code ${outcome.refusalCode} (0x${outcome.refusalCode.toString(16)})`
    }, so nothing was read`,
  "wildcards-unavailable": () =>
    "the broker said when the connection opened that it takes no wildcard subscription, so nothing was read",
});

/** What the read listened to, in words that name no id. */
function listenedTo(answer: SparkplugAgentAnswer): string {
  switch (answer.plan.op) {
    case "window":
      return answer.scoped
        ? "every message of the one group this connection names"
        : `the whole ${SPARKPLUG_NAMESPACE} namespace`;
    case "group":
      return "the one group the request named";
    case "edgeNode":
      return "the birth, death and data topics of the one edge node the request named";
    case "device":
      return "the birth, death and data topics of the one device the request named";
  }
}

/** The answer's own account of its window, which every answer's warnings open with. */
function windowSentence(answer: SparkplugAgentAnswer): string {
  const { outcome, tally } = answer;
  const stop = STOP_WORDS[outcome.endReason] as (outcome: SparkplugReadOutcome) => string;
  const counted =
    answer.plan.op === "window"
      ? `It counted ${countOf(tally.messages, "message")} from ${countOf(tally.groups, "group")}, ${countOf(tally.edgeNodes, "edge node")} and ${countOf(tally.devices, "device")}`
      : `It counted ${countOf(tally.messages, "message")} from it`;
  return `Studio listened to ${listenedTo(answer)} for ${listenedMs(outcome).toLocaleString("en-US")} ms after subscribing, in a window that ran ${windowMs(outcome).toLocaleString("en-US")} ms from the start of the read, dial included (Studio's window is ${WINDOW_MS.toLocaleString("en-US")} ms), and stopped because ${stop(outcome)}. ${counted}.`;
}

/** What the read could not count, said rather than left to read as zero. */
function lossSentences(answer: SparkplugAgentAnswer): string[] {
  const { outcome, tally } = answer;
  const out: string[] = [];
  const refused = outcome.subscriptionsRefused ?? 0;
  if (refused > 0) {
    out.push(
      `The broker refused ${countOf(refused, "subscription")} of this read and granted the rest, so the read heard less than it asked for and its counts are lower bounds.`,
    );
  }
  if (tally.undecodable + tally.payloadsNotKept > 0) {
    out.push(
      `${countOf(tally.undecodable, "payload")} could not be read as Sparkplug B and ${countOf(tally.payloadsNotKept, "payload")} came past Studio's byte budget, so their metrics are not counted; their messages are.`,
    );
  }
  return out;
}

/** The deadline's own failure, so the wording can tell it from the broker's silence. */
class AgentDeadlineError extends Error {}

/**
 * One admitted read under the read's time budget, as one fresh session through the provider's reader. A deadline ends
 * the wait, not the work: the session still ends itself on its own window clock, and its answer is dropped.
 */
export async function runSparkplugAgentRead(
  base: SparkplugReadRequest,
  plan: SparkplugAgentPlan,
  budget: ReadOnlyStatementBudget,
  reader: SparkplugReader,
): Promise<SparkplugAgentAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentDeadlineError()), budget.statementTimeoutMs);
  });
  const read = reader({
    ...base,
    filters: sparkplugAgentFilters(plan, base.groupId),
    windowSeconds: DEFAULT_WINDOW_SECONDS,
  });
  // The read's own rejection after the deadline won is observed here, so it is never an unhandled one.
  read.catch(() => undefined);
  try {
    const outcome = await Promise.race([read, deadline]);
    return { plan, scoped: base.groupId !== "", outcome, tally: tallySparkplugMessages(plan, outcome.messages ?? []) };
  } finally {
    clearTimeout(timer);
  }
}

const NOT_PASSED_ON =
  "The transport's and the broker's own words are not passed on to agent mode, since they can name an address.";

/** The sentence an outcome that read nothing is refused with, or undefined for an outcome an answer is given for. */
function failedOutcome(outcome: SparkplugReadOutcome): string | undefined {
  if (outcome.endReason === "dial-failed") {
    const code = outcome.transportErrorCode;
    if (code !== undefined && isTlsFailureCode(code)) {
      return `The broker presented a certificate Studio does not trust for this connection, so nothing was read: check the CA certificate under SSL / TLS. ${NOT_PASSED_ON}`;
    }
    return `The broker could not be reached for the read. ${NOT_PASSED_ON}`;
  }
  if (outcome.endReason === "connect-refused") {
    const code =
      outcome.refusalCode === undefined
        ? ""
        : ` with reason code ${outcome.refusalCode} (0x${outcome.refusalCode.toString(16)})`;
    return `The broker refused the connection${code}, so nothing was read: what it would not accept is this client. ${NOT_PASSED_ON}`;
  }
  if (outcome.handshook === false) {
    return `Something answered on the broker's port but did not complete the MQTT 5.0 handshake, so nothing was read. ${NOT_PASSED_ON}`;
  }
  if (STOP_WORDS[outcome.endReason] === undefined) {
    return `The broker's answer could not be read as MQTT 5.0, so the read was abandoned and nothing of it is answered. ${NOT_PASSED_ON}`;
  }
  return undefined;
}

/** The answer of one read: its one projected row, refused past the byte budget, and its window and completeness. */
export function sparkplugAgentResult(
  answer: SparkplugAgentAnswer,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const failed = failedOutcome(answer.outcome);
  if (failed !== undefined) throw new QueryError(failed, SPARKPLUG_TYPE, statement);
  const projected = projectMetadata(PROJECTIONS[answer.plan.op], [answer]);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), SPARKPLUG_TYPE, statement);
  }
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime,
    warnings: [
      { message: windowSentence(answer) },
      ...(answer.plan.op === "window" ? [] : [{ message: SPARKPLUG_EXACT_LAST_MESSAGE }]),
      ...lossSentences(answer).map((message) => ({ message })),
      { message: SPARKPLUG_COMPLETENESS },
    ],
  };
}

/** The refusal of a time budget too short for a window, before anything is sent. */
export function sparkplugAgentShortBudgetSentence(statementTimeoutMs: number): string {
  return `${TIME_BUDGET_PREFIX}: a Sparkplug agent read listens for a ${WINDOW_MS.toLocaleString("en-US")} ms window and needs at least ${SPARKPLUG_AGENT_MIN_STATEMENT_MS.toLocaleString("en-US")} ms, and this read was given ${statementTimeoutMs.toLocaleString("en-US")} ms. A window is never shortened, so nothing was sent.`;
}

/**
 * The agent's wording of a failure thrown while reading, or undefined for one the provider passes on as it is:
 * Studio's own refusals (a connection setting, the shared egress rule, an outcome `sparkplugAgentResult` already worded
 * by its kind) and a defect of ours. A session's failures arrive as outcomes, not as throws, and are worded there.
 */
export function sparkplugAgentFailure(error: unknown, deadlineMs: number, statement?: string): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, SPARKPLUG_TYPE, statement);
  if (error instanceof AgentDeadlineError) {
    return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${deadlineMs}ms`, SPARKPLUG_TYPE, statement);
  }
  return undefined;
}
