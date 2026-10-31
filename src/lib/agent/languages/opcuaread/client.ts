/**
 * The opcuaread request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/** What is withheld and why, in the words the posture uses; the server's sentence names each node id. */
const WITHHELD =
  "Withheld, with everything beneath them, because they hold certificates, account names, role identities and every open session's client, user identity and endpoint, are the server's ServerConfiguration, RoleSet and session diagnostics and its PubSub security groups and key push targets; a value read naming one answers it withheld, a browse steps over it and names it, and a history read or browse of one is refused.";

/**
 * Agent mode on OPC UA: the boundary is the provider's structural closed seam, a client that holds the read services
 * alone, Browse, BrowseNext, Read and HistoryRead, with no Write, Call, node management or subscription in it. Its
 * answers carry the server's process values, each with its engineering units, and never anything of the withheld
 * nodes, which the body names.
 */
function opcuareadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per read, one session per read, over a client that sends only Browse, BrowseNext, Read and HistoryRead`,
    title: "Agent mode reads the OPC UA server's values, history and address space, and never writes or calls a method",
    body: `Agent mode runs OPC UA reads it wrote itself, each one JSON request: the current values of the nodes it names, one node's raw history, or the children of one node. It answers the server's values as the console renders them, each with its node's engineering units and EU range as the server publishes them, or "no units published" where it publishes none, never a unit Studio guessed, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. ${WITHHELD} Each read opens its own session and closes it, so nothing is held between reads. Studio's agent client holds only Browse, BrowseNext, Read and HistoryRead, so it cannot write a value, call a method, change a node or subscribe. Nothing reaches your editor.`,
  };
}

/**
 * Plan mode on OPC UA. An address space is browsed, not listed, so the provider declares no kind the grounding walk
 * lists, and the shared "one schema read grounds it" would not be true: plan mode reads nothing from the server.
 */
function opcuareadPlanPosture(): AgentPosture {
  return {
    tone: "safe",
    headline: "Executes nothing it drafts",
    qualifier: "nothing is read from the server to ground it, and the request it drafts is never sent",
    title: "Plan mode drafts, and never runs what it drafted",
    body: "Plan mode never sends the read request it wrote. An OPC UA address space is browsed one level at a time rather than listed, so no inventory grounds the plan and plan mode reads nothing from the server: the request is drafted from your question and the node ids it names.",
  };
}

export const OPCUAREAD_CLIENT_PACK = Object.freeze({
  /** OPC UA's words. The noun is REQUEST, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an OPC UA server",
    noun: "request",
    argument: "statement",
    writes:
      "every Write, method Call, node change and subscription, and every read of the server's configuration, role identities and session diagnostics",
    reached: "the server",
    defect: "your request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The OPC UA variants. The investigation reads the server through `run_read_query`, and the operations workflow
   * sends no request. A plan (query optimization) or a profile (database assessment) is not something a server has,
   * and the data analysis's tools assume a store of records, so neither is offered: their tools could only refuse. No
   * variant auto-executes: no OPC UA answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the OPC UA server this connection reads, such as the current values of its variables with their engineering units, a variable's raw history, or what its address space holds, that is answered from what the run establishes",
      objective:
        "Your objective is a question about the OPC UA server this connection reads: its variables' values and units, their history, and its address space. Answer it from what you establish.",
      planDeliverable: "inherits",
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
    reads: opcuareadReadsPosture,
    widened: opcuareadReadsPosture,
    handoverTerms: () =>
      "An OPC UA answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
    plan: opcuareadPlanPosture,
  }),
} satisfies AgentLanguageClientPack);
