/**
 * The mqttread request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on MQTT: the boundary is the provider's structural closed table, an encoder of five packets with no
 * PUBLISH and a CONNECT with no Will, behind a valve that re-checks every outbound byte. Its answers carry counts and
 * flags only, and each states its window and that a topic not seen may still exist.
 */
function mqttreadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, one row per read, each read one 3-second window within ${seconds} s, over an encoder that cannot write a publish or a will`,
    title: "Agent mode counts what an MQTT broker delivers in a window, and never publishes",
    body: `Agent mode runs MQTT reads it wrote itself, each one JSON request: the window read listens to every topic (the filter #) for 3 seconds and answers totals only, the distinct topics seen, the messages, the retained messages and the payload bytes; the topic read listens to one topic the request names in full and answers whether a message was seen on it, its retained flag, the QoS it was delivered at, its payload size and when it was last seen. Every answer states how long it listened, why it stopped and that a topic not seen in the window may still exist, since MQTT has no command that lists topics. No answer names a topic or carries a payload, a user property or a $SYS reading, and a read whose time budget of ${seconds} s cannot hold a whole window is refused rather than shortened. Each read is a fresh session that keeps nothing. Studio's MQTT encoder writes five packets and no publish, its connect has no will, and every outbound byte is checked again before it leaves, so agent mode cannot publish, register a will, take a shared subscription or write a topic filter of its own. Nothing reaches your editor.`,
  };
}

/**
 * Plan mode on MQTT. The shared plan posture says one schema read grounds a plan, which is not true here: MQTT has no
 * command that lists topics and topic names are withheld, so nothing grounds the plan, and opening the connection is a
 * handshake that subscribes to nothing.
 */
function mqttreadPlanPosture(): AgentPosture {
  return {
    tone: "safe",
    headline: "Executes nothing it drafts",
    qualifier: "no topic is listed for it; opening the connection is a handshake that subscribes to nothing",
    title: "Plan mode plans, and never runs what it planned",
    body: "Plan mode writes its plan in prose and never subscribes to the broker. MQTT has no command that lists topics, and topic names are withheld from agent mode, so no inventory grounds the plan: the topics it names are the ones the question names. Opening the connection is a handshake, a connect and a disconnect, which subscribes to nothing, so no topic, payload or $SYS reading is read.",
  };
}

export const MQTTREAD_CLIENT_PACK = Object.freeze({
  /** MQTT's words. The noun is READ REQUEST, the editor's own word for its JSON reads, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an MQTT broker",
    noun: "read request",
    argument: "statement",
    writes:
      "every publish, will and subscription of a filter of its own, and every read of a topic name, a payload or a property",
    reached: "the broker",
    defect: "your read request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The MQTT variants. Agent mode reads counts and flags only, so the workflows that need stored values (the data
   * analysis), a plan (query optimization) or a profile (database assessment) are not offered here: their tools could
   * only refuse. What remains is the investigation, through `run_read_query`, and the operations workflow, which sends
   * no read request. A plan of the investigation is prose: an MQTT connection has no query console, so there is no
   * statement for the editor to run. No variant auto-executes: no MQTT answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about what an MQTT broker delivers, such as whether a topic the question names is being published to or holds a retained message, or how many topics and messages the broker delivers in a short window, that is answered from what the run establishes",
      objective:
        "Your objective is a question about what this MQTT broker delivers: whether topics the question names are seen, and the broker's message totals over a window. Answer it from what you establish.",
      planDeliverable: Object.freeze({ kind: "prose" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    operations: OPERATIONS_VARIANT,
  }),
  planEstimateOperation: null,
  evidenceEvents: Object.freeze({}),
  shortfallSentences: Object.freeze({}),
  readingRefusalHeadlines: Object.freeze({}),
  requirements: Object.freeze({}),
  posture: Object.freeze({
    reads: mqttreadReadsPosture,
    widened: mqttreadReadsPosture,
    handoverTerms: () =>
      "An MQTT answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
    plan: mqttreadPlanPosture,
  }),
} satisfies AgentLanguageClientPack);
