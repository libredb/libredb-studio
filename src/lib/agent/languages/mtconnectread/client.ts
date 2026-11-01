/**
 * The mtconnectread request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/** What is withheld and why, in the words the posture uses; the provider's sentence is the same rule. */
const WITHHELD =
  "Withheld are the agent's own adapter connections, the Adapter components under its Agent device, because their names, data item ids and ADAPTER_URI values carry the network address of the adapter the agent reads from; an answer counts what it withheld and lists none of it.";

/**
 * Agent mode on MTConnect: the boundary is the provider's structural closed route table, nine routes and every one a
 * GET, sent by a client with no method argument and no body parameter. Its answers carry the machine's observations
 * and asset documents, and never the adapter connections, which the body names.
 */
function mtconnectreadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per read, one request at a time on this connection's agent-mode handle and four MTConnect requests at once across Studio, over a client that sends only GET of nine routes`,
    title: "Agent mode reads the MTConnect agent's device model, observations and assets, and never writes",
    body: `Agent mode runs MTConnect reads it wrote itself, each one request line of the console's: the device model (/probe), the current observations (/current), a page of the buffer (/sample), the assets (/assets) or assets by id (/asset/{assetIds}), for every device or one. It answers the machine's observations as the console renders them, value, timestamp and sequence, and each asset's document as XML text, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. ${WITHHELD} Each read reads the agent's device model first, and the reads of this agent-mode handle never overlap. Studio's agent client sends GET of nine routes and nothing else, so it cannot set an observation, add an asset, cancel a stream or open one. Nothing reaches your editor.`,
  };
}

export const MTCONNECTREAD_CLIENT_PACK = Object.freeze({
  /** MTConnect's words. The noun is REQUEST, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an MTConnect agent",
    noun: "request",
    argument: "statement",
    writes:
      "every PUT and POST, /cancel and every streaming request, and every read of the agent's adapter connections",
    reached: "the agent",
    defect: "your request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The MTConnect variants. The investigation reads the agent through `run_read_query`, and the operations workflow
   * sends no request. A plan (query optimization) or a profile (database assessment) is not something an agent has,
   * and the data analysis's tools assume a store of records, so neither is offered: their tools could only refuse. No
   * variant auto-executes: no MTConnect answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the machines the MTConnect agent this connection reads stands in front of, such as a data item's current value, the observations of a window of its buffer, a condition's state or an asset's document, that is answered from what the run establishes",
      objective:
        "Your objective is a question about the machines the MTConnect agent this connection reads stands in front of: their device model, their observations and their assets. Answer it from what you establish.",
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
    reads: mtconnectreadReadsPosture,
    widened: mtconnectreadReadsPosture,
    handoverTerms: () =>
      "An MTConnect answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
