/**
 * The agent's reader of one MQTT read request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. A request is one JSON object of at most two keys, `read` and `topic`, each written once, and `read` names one
 * of two reads, each of which maps to one fixed plan (`MqttAgentPlan`), so no other field the request writes reaches
 * the wire:
 *
 * - `{"read": "window"}`: one subscription to the whole filter `#` for one window, answered as totals only;
 * - `{"read": "topic", "topic": "plant/line1/temp"}`: one subscription to the one topic the request names in full,
 *   answered as that topic's metadata, never its payload.
 *
 * Metadata only. Topic names are stored values (a topic path names people and devices), and so are payloads, user
 * properties, correlation data, response topics and content types, so no read lists a topic name, and the model
 * writes no filter: a filter with `+` or `#` below the root, or any prefix, would let it bisect topic names one level
 * at a time, so the only filter it can cause is `#` itself, sent by the window read, and the exact topic it names,
 * which answers seen or not seen and nothing about any other topic. A topic under a `$` root is refused: those are the
 * broker's own (`$SYS`), whose names carry each client's id on some brokers, and the shared and exclusive
 * subscription forms (`$share/`, `$queue/`, `$exclusive/`), which take messages away from the devices subscribed beside
 * Studio. Every refusal is agent mode's own sentence with the list of reads, decided by the request's text alone, and
 * none quotes the request.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the encoder holds five packets and no
 * PUBLISH, CONNECT takes no Will, and the valve re-checks every outbound byte (`encoder.ts`, `valve.ts`). This is what
 * lets the model read why it was refused, before anything is sent.
 */
import { repeatsAKey } from "@/lib/db/utils/json-repeated-key";
import { MQTT_MAX_STRING_BYTES, MQTT_READ_BUDGET_MS } from "./constants";

export type MqttAgentRefusalCode = "request" | "metadata-only";

/** The two reads of the closed table. */
export type MqttAgentOperation = "window" | "topic";

/** One read the agent may send. */
export type MqttAgentPlan = { readonly op: "window" } | { readonly op: "topic"; readonly topic: string };

export type MqttAgentReading =
  | { readonly ok: true; readonly plan: MqttAgentPlan }
  | { readonly ok: false; readonly code: MqttAgentRefusalCode; readonly message: string };

const KEYS: ReadonlySet<string> = new Set(["read", "topic"]);
const READS: ReadonlySet<string> = new Set<MqttAgentOperation>(["window", "topic"]);

const NOTHING_SENT = "Nothing was sent.";

const WINDOW_SECONDS = MQTT_READ_BUDGET_MS / 1000;

/** The list of reads every refusal ends with, and the tool description and the posture say the same. */
export const MQTT_AGENT_READS = `Agent mode on MQTT reads metadata only, one JSON object per read: {"read": "window"} listens to every topic (the filter #) for a window of ${WINDOW_SECONDS} seconds and answers totals only, the distinct topics seen, the messages, the retained messages and the payload bytes, never a topic name; {"read": "topic", "topic": "plant/line1/temp"} listens to the one topic the request names in full for the same window and answers whether a message was seen on it and how many, and of the last message seen on it its retained flag, the QoS it was delivered at, its payload size and when it arrived, never its payload.`;

export const MQTT_AGENT_SENTENCES = {
  empty: `The request holds no read. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  notObject: `An MQTT agent read is one JSON object. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  repeated: `The request writes a key twice. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  keys: `The request holds a key agent mode does not read: its keys are read and topic, so no topic filter, QoS, subscription option, payload, will or property can be written. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  notARead: `That is not one of agent mode's reads: agent mode never publishes, never registers a will, writes no topic filter of its own and reads no payload, so only the two reads below are sent. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  topicRequired: `This read names one topic in full in "topic". ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  topicNotTaken: `This read listens to every topic and takes no "topic". ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  topicName: `"topic" must be one MQTT topic name: 1 to ${MQTT_MAX_STRING_BYTES.toLocaleString("en-US")} bytes of UTF-8 text with no null character. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  wildcard: `"topic" names one topic in full, with no + and no #: a wildcard filter would let a read find topic names one level at a time, and topic names are withheld from agent mode. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
  dollar: `A topic beginning with $ is never read in agent mode: $SYS is the broker's own tree, whose topic names carry each client's id on some brokers, and $share/, $queue/ and $exclusive/ take messages away from the devices subscribed beside Studio. ${MQTT_AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: MqttAgentRefusalCode, message: string): MqttAgentReading {
  return { ok: false, code, message };
}

/**
 * Whether `topic` is text the encoder sends byte for byte as written: well-formed UTF-16 (a lone surrogate would be
 * sent as U+FFFD, a different topic), no null character ([MQTT-1.5.4-2]), at least one character and within the
 * MQTT string length.
 */
function isTopicText(topic: unknown): topic is string {
  return (
    typeof topic === "string" &&
    topic.length > 0 &&
    topic.isWellFormed() &&
    !topic.includes("\u0000") &&
    Buffer.byteLength(topic, "utf8") <= MQTT_MAX_STRING_BYTES
  );
}

/** One agent read request read to the plan the provider sends, or to why it sends nothing. Never sends anything. */
export function readMqttAgentStatement(text: string): MqttAgentReading {
  if (text.trim() === "") return refuse("request", MQTT_AGENT_SENTENCES.empty);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse's own message is not repeated: under Node it quotes the start of the text.
    return refuse("request", MQTT_AGENT_SENTENCES.notObject);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("request", MQTT_AGENT_SENTENCES.notObject);
  }
  if (repeatsAKey(text)) return refuse("request", MQTT_AGENT_SENTENCES.repeated);
  const request = parsed as Record<string, unknown>;
  if (Object.keys(request).some((key) => !KEYS.has(key))) return refuse("request", MQTT_AGENT_SENTENCES.keys);

  const { read, topic } = request;
  if (typeof read !== "string" || !READS.has(read)) return refuse("metadata-only", MQTT_AGENT_SENTENCES.notARead);

  if (read === "window") {
    if (topic !== undefined) return refuse("request", MQTT_AGENT_SENTENCES.topicNotTaken);
    return { ok: true, plan: { op: "window" } };
  }
  if (topic === undefined) return refuse("request", MQTT_AGENT_SENTENCES.topicRequired);
  if (!isTopicText(topic)) return refuse("request", MQTT_AGENT_SENTENCES.topicName);
  if (topic.startsWith("$")) return refuse("metadata-only", MQTT_AGENT_SENTENCES.dollar);
  if (topic.includes("+") || topic.includes("#")) return refuse("metadata-only", MQTT_AGENT_SENTENCES.wildcard);
  return { ok: true, plan: { op: "topic", topic } };
}
