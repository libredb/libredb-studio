/**
 * The mqttread request language's MCP facet: `run_mqtt_read`, one JSON read request, read and admitted by the agent's
 * own MQTT reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so a call reads what
 * an agent read reads: the window over `#` answered as totals, or one topic the request names in full answered as its
 * metadata, each one fresh session over the closed five-packet encoder and the valve, which can send no PUBLISH and no
 * Will. Every answer is the metadata-only projection of counts and flags, never a topic name or a payload, and it
 * carries the provider's warnings as its notes, since they are Studio's own sentences and they say what a window
 * cannot: what it listened for and that a topic not seen in it may still exist.
 *
 * Two broker sessions per call: the acquisition's handshake, which subscribes to nothing, and the read. The read is
 * refused below the window plus its dial, so the tool takes no `timeout_ms` that cannot leave that after the
 * handshake, and a smaller one is refused before anything is acquired.
 *
 * No `database` key: a broker is one topic space and declares no `catalogSessions`. An MQTT broker declares no relation
 * kind, so the facet holds no tables, and inspect_schema refuses an MQTT connection by name and points here.
 */
import { z } from "zod";
import { MQTT_AGENT_MIN_STATEMENT_MS, MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { MQTT_READ_BUDGET_MS } from "@/lib/db/providers/keyvalue/mqtt/constants";
import type { AgentLanguageMcpFacet } from "../mcp";

/**
 * What a call leaves the acquisition's handshake on top of the read's own least: the handshake dials the broker and
 * waits for its CONNACK before the read's time is counted. A handshake slower than this leaves the read less than
 * its least, and the provider refuses the read before anything more is sent.
 */
const HANDSHAKE_ALLOWANCE_MS = 1_000;

/** The least timeout_ms a call takes: the read's own least plus the handshake's allowance. */
export const MQTT_MCP_LEAST_TIMEOUT_MS = MQTT_AGENT_MIN_STATEMENT_MS + HANDSHAKE_ALLOWANCE_MS;

const ms = (value: number) => value.toLocaleString("en-US");

export const MQTTREAD_MCP_FACET = Object.freeze({
  tool: "run_mqtt_read",
  title: "Run a read-only MQTT read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: true,
  leastTimeout: {
    ms: MQTT_MCP_LEAST_TIMEOUT_MS,
    why: `an MQTT read listens for a ${ms(MQTT_READ_BUDGET_MS)} ms window and needs ${ms(MQTT_AGENT_MIN_STATEMENT_MS)} ms with its dial, after the connection's own handshake, and a window is never shortened, so nothing was sent.`,
  },
  answersWarnings: true,
  describe: ({ engines, limits }) =>
    `Run one read-only MQTT read on a connection: one JSON object, {"read": "window"} or {"read": "topic", "topic": "plant/line1/temp"}. The window read subscribes to every topic (the filter #) for one ${ms(MQTT_READ_BUDGET_MS)} ms window and answers totals only: distinct topics seen, messages, retained messages and payload bytes, never a topic name. The topic read subscribes to the one topic the request names in full for the same window and answers whether a message was seen on it, how many, and the last one's retained flag, delivered QoS, payload size and arrival, never its payload or the topic it named. The one row says how long the window ran (window_ms) and listened (listened_ms), why it stopped (stop_reason, with broker_reason_code when the broker, or its ACL, refused the subscription) and its scope, never complete; notes say the same in words. ${MQTT_COMPLETENESS} Every other filter, + and # below the root, a topic under a $ root ($SYS, $share/ and the like), a publish, a will and any other key are refused before the broker is reached. A call opens two broker sessions, each with a fresh client id: the connection's handshake, which subscribes to nothing, then the read. timeout_ms must be at least ${MQTT_MCP_LEAST_TIMEOUT_MS}, and a smaller one is refused before anything is sent. inspect_schema refuses an MQTT connection, since topic names are withheld. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, and every read answers one row.`,
  words: {
    fewerFields: "Read one topic the request names in full instead of the window",
    readPast: () => "read one topic the request names in full, since an MQTT read answers one row and is never paged.",
    rowOverCap:
      "The one row of this read is larger than the 32 KiB result limit, which a count and a flag never are. Run the read again.",
    reached: "the broker",
  },
} as const satisfies AgentLanguageMcpFacet);
