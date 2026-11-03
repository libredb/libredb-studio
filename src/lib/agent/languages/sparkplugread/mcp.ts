/**
 * The sparkplugread request language's MCP facet: `run_sparkplug_read`, one JSON read request, read and admitted by the
 * agent's own Sparkplug reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so a call reads what
 * an agent read reads: the window over the whole namespace (or the connection's own group) answered as totals, or one
 * group, edge node or device the request names in full answered as its counts, each one fresh session over the closed
 * encoder, which can send no PUBLISH, command, rebirth request, host state and no Will. Every answer is the
 * metadata-only projection of counts and flags, never an id, a metric name or a value, and it carries the provider's
 * warnings as its notes, since they are Studio's own sentences and they say what a window cannot: what it listened for
 * and that an edge node or device not seen in it may still exist.
 *
 * Two broker sessions per call: the acquisition's handshake, which subscribes to nothing, and the read. The read is
 * refused below the window plus its dial, so the tool takes no `timeout_ms` that cannot leave that after the
 * handshake, and a smaller one is refused before anything is acquired.
 *
 * No `database` key: the connection's group setting is its scope, and it declares no `catalogSessions`. An edge node
 * and a device are relation kinds, so the facet holds tables; inspect_schema lists none on Sparkplug all the same,
 * since an agent-mode handle declares no container level and no object kind, ids being withheld, and the description
 * says so.
 */
import { z } from "zod";
import {
  DEFAULT_WINDOW_SECONDS,
  SPARKPLUG_AGENT_MIN_STATEMENT_MS,
} from "@/lib/db/providers/industrial/sparkplug/constants";
import type { AgentLanguageMcpFacet } from "../mcp";

/**
 * What a call leaves the acquisition's handshake on top of the read's own least: the handshake dials the broker and
 * waits for its CONNACK before the read's time is counted. A handshake slower than this leaves the read less than
 * its least, and the provider refuses the read before anything more is sent.
 */
const HANDSHAKE_ALLOWANCE_MS = 1_000;

/** The least timeout_ms a call takes: the read's own least plus the handshake's allowance. */
export const SPARKPLUG_MCP_LEAST_TIMEOUT_MS = SPARKPLUG_AGENT_MIN_STATEMENT_MS + HANDSHAKE_ALLOWANCE_MS;

const WINDOW_MS = DEFAULT_WINDOW_SECONDS * 1000;
const ms = (value: number) => value.toLocaleString("en-US");

export const SPARKPLUGREAD_MCP_FACET = Object.freeze({
  tool: "run_sparkplug_read",
  title: "Run a read-only Sparkplug read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  leastTimeout: {
    ms: SPARKPLUG_MCP_LEAST_TIMEOUT_MS,
    why: `a Sparkplug read listens for a ${ms(WINDOW_MS)} ms window and needs ${ms(SPARKPLUG_AGENT_MIN_STATEMENT_MS)} ms with its dial, after the connection's own handshake, and a window is never shortened, so nothing was sent.`,
  },
  answersWarnings: true,
  describe: ({ engines, limits }) =>
    `Run one read-only Sparkplug read on a connection: one JSON object, {"read": "window"}, {"read": "group", "group": "G"}, {"read": "edgeNode", "group": "G", "edgeNode": "E"} or {"read": "device", "group": "G", "edgeNode": "E", "device": "D"}. The window read subscribes to the whole spBv1.0 namespace, or the connection's own group when it names one, for one ${ms(WINDOW_MS)} ms window and answers totals only: distinct groups, edge nodes and devices seen, messages by type, metrics and payload bytes, never an id. An exact read subscribes to the one object the request names in full and answers whether it was seen, its messages by type, metrics, whether a birth or death was seen and its last arrival, never a metric name or value and never the id it named; a connection that names a group refuses a read of another. The one row says how long the window ran (window_ms) and listened (listened_ms), why it stopped (stop_reason, broker_reason_code) and its scope, never complete; notes say the same in words, and that no answer is complete: an edge node or device not seen in the window may still exist, and no answer says one is online, offline or absent. An id with +, # or /, a group named STATE, any other key or read, a command and a will are refused before the broker is reached. A call opens two broker sessions, each with a fresh client id: the handshake, which subscribes to nothing, then the read. timeout_ms must be at least ${SPARKPLUG_MCP_LEAST_TIMEOUT_MS}, and a smaller one is refused before anything is sent. inspect_schema lists no group, edge node or device of a Sparkplug connection, since ids are withheld. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, and every read answers one row.`,
  words: {
    fewerFields: "Read one group, edge node or device the request names in full instead of the window",
    readPast: () =>
      "read one group, edge node or device the request names in full, since a Sparkplug read answers one row and is never paged.",
    rowOverCap:
      "The one row of this read is larger than the 32 KiB result limit, which a count and a flag never are. Run the read again.",
    reached: "the broker",
  },
} as const satisfies AgentLanguageMcpFacet);
