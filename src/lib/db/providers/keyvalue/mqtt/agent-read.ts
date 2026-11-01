/**
 * What an agent's MQTT read sends and answers: each read of the closed table (`agent-statement.ts`) run as one fresh
 * session over the provider's own encoder and valve, and its answer projected to counts, flags and fixed names, with
 * the completeness sentence on every answer and every failure worded by its kind alone.
 *
 * ONE FRESH SESSION PER READ. Each read dials, sends CONNECT with Clean Start and a zero Session Expiry Interval, one
 * SUBSCRIBE (to `#` for the window read, to the exact topic for the topic read), and leaves with DISCONNECT when the
 * window ends: nothing is kept from one read for the next, and the broker keeps nothing for the client after it.
 *
 * A WINDOW IS NOT A CUT. MQTT has no command that lists topics, so a read is what one subscription delivered in one
 * window, and its answer is the window's own totals: how long it listened, what it counted and why it stopped. Studio's
 * message and byte budgets can end a window early, and the answer says so as its stop reason; nothing the read counted
 * is dropped from a figure. What is never claimed is completeness: the scope is never `complete`, and every answer says
 * that a topic not seen in the window may still exist.
 *
 * Metadata only, as the capability `metadataOnly` states it: no column's name comes from the broker, no topic name is
 * answered (the topic read does not echo the topic it named), and no payload, user property, correlation data,
 * response topic or content type is read into a row. A loss the read can prove is counted, never named, since the
 * editor's sentence for it names the topic.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { byteBudgetSentence, measureResultBytes, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { MqttAgentOperation, MqttAgentPlan } from "./agent-statement";
import {
  MQTT_CONNECT_TIMEOUT_MS,
  MQTT_READ_BUDGET_BYTES,
  MQTT_READ_BUDGET_MESSAGES,
  MQTT_READ_BUDGET_MS,
  MQTT_TYPE,
  MQTT_WILDCARD_FILTER,
} from "./constants";
import {
  type MqttEndReason,
  type MqttReadOutcome,
  MqttSessionError,
  type MqttSessionOptions,
  type MqttTopicRow,
  readTopics,
} from "./session";

/**
 * The least of the read's time budget the dial is given. An agent read listens for `MQTT_READ_BUDGET_MS`, so a budget
 * shorter than that plus this is refused before anything is sent, rather than cut into a shorter window.
 */
const MQTT_AGENT_MIN_DIAL_MS = 1_000;

/** The least time budget an agent read is admitted with: the window plus the shortest dial. */
export const MQTT_AGENT_MIN_STATEMENT_MS = MQTT_READ_BUDGET_MS + MQTT_AGENT_MIN_DIAL_MS;

/**
 * What the dial leaves of the time budget for the session to leave and answer, so a window that ends on its own clock
 * is answered before the read's deadline rather than racing it.
 */
const MQTT_AGENT_SETTLE_MS = 250;

/** One read's answer, before projection: the session's outcome, and for the topic read the row of its topic. */
export type MqttAgentAnswer =
  | { readonly op: "window"; readonly outcome: MqttReadOutcome }
  | { readonly op: "topic"; readonly outcome: MqttReadOutcome; readonly row: MqttTopicRow | undefined };

/** The window's own facts, which open every answer's row. */
interface WindowFacts {
  readonly outcome: MqttReadOutcome;
}

const WINDOW_COLUMNS: MetadataProjection<WindowFacts> = [
  { column: "window_ms", kind: "count", read: () => MQTT_READ_BUDGET_MS },
  { column: "listened_ms", kind: "count", read: (w) => w.outcome.elapsedMs },
  { column: "stop_reason", kind: "name", read: (w) => w.outcome.endReason },
  // Never "complete": MQTT gives no way to establish it.
  { column: "scope", kind: "name", read: (w) => w.outcome.scope },
  { column: "broker_reason_code", kind: "count", optional: true, read: (w) => w.outcome.endCode },
];

const WINDOW: MetadataProjection<WindowFacts> = [
  ...WINDOW_COLUMNS,
  { column: "topics_seen", kind: "count", read: (w) => w.outcome.topics.size },
  { column: "messages", kind: "count", read: (w) => w.outcome.messages },
  { column: "retained_messages", kind: "count", read: (w) => w.outcome.retainedMessages },
  { column: "payload_bytes", kind: "count", read: (w) => w.outcome.payloadBytes },
  { column: "messages_lost", kind: "count", read: (w) => w.outcome.provenLoss.length },
];

interface TopicFacts extends WindowFacts {
  readonly row: MqttTopicRow | undefined;
}

const TOPIC: MetadataProjection<TopicFacts> = [
  ...WINDOW_COLUMNS,
  { column: "seen", kind: "flag", read: (t) => t.row !== undefined },
  { column: "messages", kind: "count", read: (t) => t.row?.messages ?? 0 },
  // A topic not seen has no last message, so its figures are null, never 0 or false.
  { column: "retained", kind: "flag", optional: true, read: (t) => t.row?.retained },
  { column: "delivered_qos", kind: "count", optional: true, read: (t) => t.row?.qos },
  { column: "payload_bytes", kind: "count", optional: true, read: (t) => t.row?.payloadBytes },
  { column: "last_seen_ms", kind: "count", optional: true, read: (t) => t.row?.lastSeenMs },
  { column: "messages_lost", kind: "count", read: (t) => t.outcome.provenLoss.length },
];

const PROJECTIONS = Object.freeze({
  window: WINDOW,
  topic: TOPIC,
} satisfies Record<MqttAgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for MQTT: every read's columns and their kinds. */
export const MQTT_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

/** The sentence every answer carries, and the tool description, the grounding and the posture say the same. */
export const MQTT_COMPLETENESS =
  "A topic not seen in the window may still exist: MQTT has no command that lists topics, so a subscriber sees a topic only when a message on it arrives in the window or the broker holds a retained message on it, and no answer is a complete count of the broker's topics or proof that a topic does not exist.";

/** Why a window stopped, in agent mode's words: no remedy that writes a narrower filter, which agent mode cannot. */
function stopWords(outcome: MqttReadOutcome): string {
  const reasons: Readonly<Record<MqttEndReason, string>> = {
    "budget-time": "the window ended",
    "budget-messages": `Studio's message budget of ${MQTT_READ_BUDGET_MESSAGES.toLocaleString("en-US")} messages was reached before the window ended`,
    "budget-bytes": `Studio's byte budget of ${MQTT_READ_BUDGET_BYTES.toLocaleString("en-US")} bytes was reached before the window ended`,
    "server-disconnect": "the broker closed the connection before the window ended",
    "transport-closed": "the connection closed before the window ended",
    "subscription-refused": `the broker refused the subscription${
      outcome.endCode === undefined ? "" : ` with reason code ${outcome.endCode} (0x${outcome.endCode.toString(16)})`
    }, so nothing was read`,
    handshake: "the session subscribed to nothing",
  };
  return reasons[outcome.endReason];
}

/** The answer's own account of its window, which every answer's warnings open with. */
function windowSentence(answer: MqttAgentAnswer): string {
  const { outcome } = answer;
  const listened =
    answer.op === "window"
      ? `every topic (the filter ${MQTT_WILDCARD_FILTER}, which never matches a topic under a $ root)`
      : "the one topic the request named";
  const counted =
    answer.op === "window"
      ? `It counted ${outcome.messages.toLocaleString("en-US")} messages on ${outcome.topics.size.toLocaleString("en-US")} distinct topics, ${outcome.retainedMessages.toLocaleString("en-US")} of them retained`
      : `It counted ${(answer.row?.messages ?? 0).toLocaleString("en-US")} messages on that topic`;
  return `Studio listened to ${listened} for ${outcome.elapsedMs.toLocaleString("en-US")} ms of a ${MQTT_READ_BUDGET_MS.toLocaleString("en-US")} ms window and stopped because ${stopWords(outcome)}. ${counted}.`;
}

/** What the read proved it lost, counted and never named: the editor's sentence for a loss names its topic. */
function lossSentence(outcome: MqttReadOutcome): string | undefined {
  const lost = outcome.provenLoss.length;
  if (lost === 0) return undefined;
  return `${lost.toLocaleString("en-US")} ${lost === 1 ? "loss was" : "losses were"} proved in this window: a message over the inbound limit, or messages that arrived with no topic name. Their topics are not named to agent mode.`;
}

/** The deadline's own failure, so the wording can tell it from the broker's silence. */
class AgentDeadlineError extends Error {}

/**
 * The session options of one agent read: the connection's own (which keep no payload and are never handshake-only),
 * with the filter the plan fixes and a dial bounded so dial and window fit the read's time budget.
 */
function readOptions(base: MqttSessionOptions, plan: MqttAgentPlan, budget: ReadOnlyStatementBudget) {
  return {
    ...base,
    // In place of the connection's own discovery filter, which no agent read uses.
    filter: plan.op === "window" ? MQTT_WILDCARD_FILTER : plan.topic,
    dialTimeoutMs: Math.min(
      MQTT_CONNECT_TIMEOUT_MS,
      budget.statementTimeoutMs - MQTT_READ_BUDGET_MS - MQTT_AGENT_SETTLE_MS,
    ),
  } satisfies MqttSessionOptions;
}

/**
 * One admitted read under the read's time budget, as one fresh session. A deadline ends the wait, not the work: the
 * session still ends itself on its own window and dial clocks, and its answer is dropped. `session` is the test seam
 * for a session that outlives the deadline, which the product's own clocks never let one do.
 */
export async function runMqttAgentRead(
  base: MqttSessionOptions,
  plan: MqttAgentPlan,
  budget: ReadOnlyStatementBudget,
  session: (options: MqttSessionOptions) => Promise<MqttReadOutcome> = readTopics,
): Promise<MqttAgentAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentDeadlineError()), budget.statementTimeoutMs);
  });
  const read = session(readOptions(base, plan, budget));
  // The read's own rejection after the deadline won is observed here, so it is never an unhandled one.
  read.catch(() => undefined);
  try {
    const outcome = await Promise.race([read, deadline]);
    return plan.op === "window"
      ? { op: "window", outcome }
      : { op: "topic", outcome, row: outcome.topics.get(plan.topic) };
  } finally {
    clearTimeout(timer);
  }
}

/** The answer of one read: its one projected row, refused past the byte budget, and its window and completeness. */
export function mqttAgentResult(
  answer: MqttAgentAnswer,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  const projected =
    answer.op === "window"
      ? projectMetadata(WINDOW, [{ outcome: answer.outcome }])
      : projectMetadata(TOPIC, [{ outcome: answer.outcome, row: answer.row }]);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), MQTT_TYPE, statement);
  }
  const loss = lossSentence(answer.outcome);
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime,
    warnings: [
      { message: windowSentence(answer) },
      ...(loss === undefined ? [] : [{ message: loss }]),
      { message: MQTT_COMPLETENESS },
    ],
  };
}

/** The refusal of a time budget too short for a window, before anything is sent. */
export function mqttAgentShortBudgetSentence(statementTimeoutMs: number): string {
  return `${TIME_BUDGET_PREFIX}: an MQTT agent read listens for a ${MQTT_READ_BUDGET_MS.toLocaleString("en-US")} ms window and needs at least ${MQTT_AGENT_MIN_STATEMENT_MS.toLocaleString("en-US")} ms with the dial, and this read was given ${statementTimeoutMs.toLocaleString("en-US")} ms. A window is never shortened, so nothing was sent.`;
}

const NOT_PASSED_ON =
  "The transport's and the broker's own words are not passed on to agent mode, since they can name an address.";

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is: Studio's own refusals (a
 * connection setting, the shared egress rule) and a defect of ours. A session failure is worded by its kind alone;
 * a refused handshake keeps Studio's own sentence for the CONNACK code, which names no broker text and no credential.
 */
export function mqttAgentFailure(error: unknown, deadlineMs: number, statement?: string): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, MQTT_TYPE, statement);
  if (error instanceof AgentDeadlineError) {
    return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${deadlineMs}ms`, MQTT_TYPE, statement);
  }
  if (error instanceof DatabaseConfigError) return undefined;
  if (!(error instanceof MqttSessionError)) return undefined;
  const code =
    error.reasonCode === undefined ? "" : ` (reason code ${error.reasonCode}, 0x${error.reasonCode.toString(16)})`;
  const words: Readonly<Record<MqttSessionError["category"], string>> = {
    refused: error.message,
    handshake: `The broker did not complete the MQTT 5.0 handshake${code}, so nothing was read. ${NOT_PASSED_ON}`,
    unreachable: `The broker could not be reached for the read. ${NOT_PASSED_ON}`,
    protocol: `The broker's answer could not be read as MQTT 5.0, so the read was abandoned and nothing of it is answered. ${NOT_PASSED_ON}`,
  };
  return new QueryError(words[error.category], MQTT_TYPE, statement);
}
