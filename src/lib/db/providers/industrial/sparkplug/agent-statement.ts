/**
 * The agent's reader of one Sparkplug read request: what the agent read-only profile sends, read before anything is
 * sent.
 *
 * Pure. A request is one JSON object of at most four keys, `read`, `group`, `edgeNode` and `device` (the console's
 * own names for the three levels), each written once, and `read` names one of four reads, each of which maps to one
 * fixed plan (`SparkplugAgentPlan`), so no other field the request writes reaches the wire:
 *
 * - `{"read": "window"}`: one subscription to the whole namespace, `spBv1.0/#`, for one window, answered as totals;
 * - `{"read": "group", "group": "G"}`: one subscription to the one group the request names in full;
 * - `{"read": "edgeNode", "group": "G", "edgeNode": "E"}`: the edge node's own birth, death and data topics, written
 *   in full with no wildcard;
 * - `{"read": "device", "group": "G", "edgeNode": "E", "device": "D"}`: the device's own birth, death and data topics,
 *   written in full with no wildcard.
 *
 * Metadata only. Group, edge node, device and host application ids are stored values (they name plants, machines and
 * people), and so are metric names, values, properties, datasets, templates and aliases, so no read lists an id and
 * the model writes no filter: an id with `+` or `#` would let it find ids one level at a time, and an id with `/`
 * would address another level, so each id is one level named in full. A group named `STATE` is refused, since
 * `spBv1.0/STATE/` is where host applications publish their state under their own ids. No request can name a topic,
 * a `$sparkplug/` certificate, a shared subscription, a command, a rebirth, a host id, a publish or a will: none is a
 * key of the table. Every refusal is agent mode's own sentence with the list of reads, decided by the request's text
 * alone, so a withheld id and a missing one are refused alike, and none quotes the request.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the encoder holds five packets and no
 * PUBLISH, and CONNECT takes no Will (`encoder.ts`). This is what lets the model read why it was refused, before
 * anything is sent.
 */
import { DEFAULT_WINDOW_SECONDS, SPARKPLUG_AGENT_MAX_ID_BYTES } from "./constants";

export type SparkplugAgentRefusalCode = "request" | "metadata-only";

/** The four reads of the closed table. */
export type SparkplugAgentOperation = "window" | "group" | "edgeNode" | "device";

/** One read the agent may send. */
export type SparkplugAgentPlan =
  | { readonly op: "window" }
  | { readonly op: "group"; readonly group: string }
  | { readonly op: "edgeNode"; readonly group: string; readonly edgeNode: string }
  | { readonly op: "device"; readonly group: string; readonly edgeNode: string; readonly device: string };

export type SparkplugAgentReading =
  | { readonly ok: true; readonly plan: SparkplugAgentPlan }
  | { readonly ok: false; readonly code: SparkplugAgentRefusalCode; readonly message: string };

/** The id keys in level order, and which reads take each. */
const ID_KEYS = ["group", "edgeNode", "device"] as const;
type IdKey = (typeof ID_KEYS)[number];

const IDS_OF: Readonly<Record<SparkplugAgentOperation, readonly IdKey[]>> = Object.freeze({
  window: [],
  group: ["group"],
  edgeNode: ["group", "edgeNode"],
  device: ["group", "edgeNode", "device"],
});

const KEYS: ReadonlySet<string> = new Set(["read", ...ID_KEYS]);

const NOTHING_SENT = "Nothing was sent.";

/** The list of reads every refusal ends with, and the tool description and the posture say the same. */
export const SPARKPLUG_AGENT_READS = `Agent mode on Sparkplug reads metadata only, one JSON object per read, each listening for a window of ${DEFAULT_WINDOW_SECONDS} seconds: {"read": "window"} listens to the whole spBv1.0 namespace and answers totals only, the distinct groups, edge nodes and devices seen, the NBIRTH, NDEATH, NDATA, DBIRTH, DDEATH and DDATA messages, the metrics they carried and their payload bytes, never an id; {"read": "group", "group": "G"}, {"read": "edgeNode", "group": "G", "edgeNode": "E"} and {"read": "device", "group": "G", "edgeNode": "E", "device": "D"} listen to the one group, edge node or device the request names in full and answer whether it was seen in the window, its messages by type, the metrics they carried, whether a birth or a death was seen and when its last message arrived, never a metric name or value.`;

export const SPARKPLUG_AGENT_SENTENCES = {
  empty: `The request holds no read. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  notObject: `A Sparkplug agent read is one JSON object. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  repeated: `The request writes a key twice. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  keys: `The request holds a key agent mode does not read: its keys are read, group, edgeNode and device, so no topic, filter, window, command, rebirth, host id, payload, will or certificate can be written. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  notARead: `That is not one of agent mode's reads: agent mode never publishes, never sends a command or a rebirth request, never takes a host application's role, never registers a will, writes no topic filter of its own and reads no metric value, so only the four reads below are sent. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  idsRequired: `This read names its group, and for an edge node or a device the levels above it, each in full. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  idsNotTaken: `This read takes only the ids of its own level and the levels above it. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  idText: `An id is one Sparkplug topic level: 1 to ${SPARKPLUG_AGENT_MAX_ID_BYTES.toLocaleString("en-US")} bytes of UTF-8 text with no null character. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  wildcard: `An id is named in full, with no + and no #: a wildcard would let a read find ids one level at a time, and group, edge node and device ids are withheld from agent mode. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  separator: `An id is one topic level and holds no /: a / would address another level of the namespace. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
  state: `A group named STATE is never read in agent mode: spBv1.0/STATE/ is where host applications publish their state, under their own ids, which are withheld. ${SPARKPLUG_AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: SparkplugAgentRefusalCode, message: string): SparkplugAgentReading {
  return { ok: false, code, message };
}

/**
 * Whether a key is written twice in the one object `text` holds, which JSON.parse has already accepted as one object
 * of scalars and nested values: the scan tells keys from values by the object they sit in, and decodes each key's
 * spelling as JSON does, so `"group"` is `group`.
 *
 * A provider-local copy of the MQTT reader's scan: the rule that keeps an engine's code in its own directory leaves no
 * shared module both may import, and the scan is small enough that two copies cost less than a shared core.
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

/**
 * Whether `id` is text the encoder sends byte for byte as written: well-formed UTF-16 (a lone surrogate would be sent
 * as U+FFFD, a different id), no null character, at least one character and within Studio's id length.
 */
function isIdText(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.isWellFormed() &&
    !id.includes("\u0000") &&
    Buffer.byteLength(id, "utf8") <= SPARKPLUG_AGENT_MAX_ID_BYTES
  );
}

/** One agent read request read to the plan the provider sends, or to why it sends nothing. Never sends anything. */
export function readSparkplugAgentStatement(text: string): SparkplugAgentReading {
  if (text.trim() === "") return refuse("request", SPARKPLUG_AGENT_SENTENCES.empty);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse's own message is not repeated: under Node it quotes the start of the text.
    return refuse("request", SPARKPLUG_AGENT_SENTENCES.notObject);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("request", SPARKPLUG_AGENT_SENTENCES.notObject);
  }
  if (repeatsAKey(text)) return refuse("request", SPARKPLUG_AGENT_SENTENCES.repeated);
  const request = parsed as Record<string, unknown>;
  if (Object.keys(request).some((key) => !KEYS.has(key))) return refuse("request", SPARKPLUG_AGENT_SENTENCES.keys);

  const { read } = request;
  if (typeof read !== "string" || !Object.hasOwn(IDS_OF, read)) {
    return refuse("metadata-only", SPARKPLUG_AGENT_SENTENCES.notARead);
  }
  const op = read as SparkplugAgentOperation;
  const wanted = IDS_OF[op];
  for (const key of ID_KEYS) {
    const given = request[key] !== undefined;
    if (given && !wanted.includes(key)) return refuse("request", SPARKPLUG_AGENT_SENTENCES.idsNotTaken);
    if (!given && wanted.includes(key)) return refuse("request", SPARKPLUG_AGENT_SENTENCES.idsRequired);
  }
  const ids = wanted.map((key) => request[key]);
  if (!ids.every(isIdText)) return refuse("request", SPARKPLUG_AGENT_SENTENCES.idText);
  if (ids.some((id) => id.includes("+") || id.includes("#"))) {
    return refuse("metadata-only", SPARKPLUG_AGENT_SENTENCES.wildcard);
  }
  if (ids.some((id) => id.includes("/"))) return refuse("request", SPARKPLUG_AGENT_SENTENCES.separator);
  if (ids[0] === "STATE") return refuse("metadata-only", SPARKPLUG_AGENT_SENTENCES.state);

  const [group, edgeNode, device] = ids as [string, string, string];
  switch (op) {
    case "window":
      return { ok: true, plan: { op } };
    case "group":
      return { ok: true, plan: { op, group } };
    case "edgeNode":
      return { ok: true, plan: { op, group, edgeNode } };
    case "device":
      return { ok: true, plan: { op, group, edgeNode, device } };
  }
}
