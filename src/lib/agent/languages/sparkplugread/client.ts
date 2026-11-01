/**
 * The sparkplugread request language's client facet: its copy, its workflow variants and its posture, as data a
 * browser bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Sparkplug: the boundary is the provider's structural closed table, an encoder of five packets with no
 * PUBLISH and a CONNECT with no Will. Its answers carry counts and flags only, and each states its window and that an
 * edge node or device not seen may still exist.
 */
function sparkplugreadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, one row per read, each read one 3-second window within ${seconds} s, over an encoder that cannot write a publish, a command or a will`,
    title: "Agent mode counts what a Sparkplug plant publishes in a window, and never publishes",
    body: `Agent mode runs Sparkplug reads it wrote itself, each one JSON request: the window read listens to the whole spBv1.0 namespace for 3 seconds and answers totals only, the distinct groups, edge nodes and devices seen, the birth, death and data messages by type, the metrics they carried and their payload bytes; the group, edge node and device reads listen to one object the request names in full and answer whether it was seen, its messages by type, its metric count, whether a birth or a death was seen and when its last message arrived. Every answer states how long it listened, why it stopped and that an edge node or device not seen in the window may still exist, since a birth certificate is published at QoS 0 and not retained, and no answer says a node is online or offline. No answer names a group, edge node, device or host application, or carries a metric name, a value or a stored certificate, and a read whose time budget of ${seconds} s cannot hold a whole window is refused rather than shortened. Each read is a fresh session that keeps nothing. Studio's Sparkplug encoder writes five packets and no publish, and its connect has no will, so agent mode cannot publish, send a command or a rebirth request, take a host application's role, register a will or write a topic filter of its own. Nothing reaches your editor.`,
  };
}

/**
 * Plan mode on Sparkplug. The shared plan posture says one schema read grounds a plan, which is not true here: no
 * command lists edge nodes and ids are withheld, so nothing grounds the plan, and opening the connection is a
 * handshake that subscribes to nothing.
 */
function sparkplugreadPlanPosture(): AgentPosture {
  return {
    tone: "safe",
    headline: "Executes nothing it drafts",
    qualifier:
      "no group, edge node or device is listed for it; opening the connection is a handshake that subscribes to nothing",
    title: "Plan mode plans, and never runs what it planned",
    body: "Plan mode writes its plan in prose and never subscribes to the broker. It drafts no read request: the editor's console request reads metric values, which agent mode never reads, and agent mode alone sends the window, group, edge node and device reads. Sparkplug has no command that lists edge nodes or devices, and their ids are withheld from agent mode, so no inventory grounds the plan: the ids it names are the ones the question names. Opening the connection is a handshake, a connect and a disconnect, which subscribes to nothing, so no id, metric or stored certificate is read.",
  };
}

export const SPARKPLUGREAD_CLIENT_PACK = Object.freeze({
  /** Sparkplug's words. The noun is READ REQUEST, the editor's own word for its JSON reads, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Sparkplug plant",
    noun: "read request",
    argument: "statement",
    writes:
      "every publish, command, rebirth request, host state, will and subscription of a filter of its own, and every read of an id, a metric or a stored certificate",
    reached: "the broker",
    defect: "your read request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Sparkplug variants. Agent mode reads counts and flags only, so the workflows that need stored values (the data
   * analysis), a plan (query optimization) or a profile (database assessment) are not offered here: their tools could
   * only refuse. What remains is the investigation, through `run_read_query`, and the operations workflow, which sends
   * no read request. A plan of the investigation is prose: the editor's console request reads metric values, which
   * agent mode never reads, so there is no statement for a plan to hand the editor. No variant auto-executes: no
   * Sparkplug answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about what a Sparkplug plant publishes, such as whether a group, edge node or device the question names is publishing, whether its birth or death was seen, or how many edge nodes, devices and messages the plant publishes in a short window, that is answered from what the run establishes",
      objective:
        "Your objective is a question about what this Sparkplug plant publishes: whether the groups, edge nodes and devices the question names are seen, and the plant's message totals over a window. Answer it from what you establish.",
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
    reads: sparkplugreadReadsPosture,
    widened: sparkplugreadReadsPosture,
    handoverTerms: () =>
      "A Sparkplug answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
    plan: sparkplugreadPlanPosture,
  }),
} satisfies AgentLanguageClientPack);
