/**
 * The netconfrpc request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on NETCONF: the boundary is the provider's structural closed table, a client whose requests are three
 * reads and a close of the one request builder, which holds no write. Its answers carry the device's configuration and
 * state, never anything withheld, which the body names kind by kind before anything counts them.
 */
function netconfrpcReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per read, over a client that sends only get, get-config, get-data and get-schema, with ietf-keystore, ietf-netconf-acm, nacm:default-deny-all nodes, crypt-hash leaves, ietf-crypto-types secrets, leafrefs to a withheld node, unresolved leafrefs and entries of lists keyed by a withheld leaf withheld`,
    title: "Agent mode reads the NETCONF device's configuration and state, and never writes",
    body: `Agent mode runs NETCONF reads it wrote itself, each one JSON request: the configuration (get-config on running, candidate or startup) or the configuration and state (get-data on operational or intended) under one path, or one module's YANG text (get-schema), and answers the values as text, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Before every read it reads the YANG modules the device serves and withholds the ietf-keystore module whole, the ietf-netconf-acm module whole, every node a module marks nacm:default-deny-all, every leaf typed crypt-hash, the private-key-type, key-type and password-type choices of ietf-crypto-types, every leafref that may point at a withheld node, every unresolved leafref, and every entry of a list keyed by a withheld leaf; a withheld node answers its path and reason, never its value, and a read whose modules cannot be read is refused. Studio's agent client sends only the get, get-config, get-data and get-schema reads and the close-session that ends its session, so it cannot send an edit-config, a lock or any other operation. The SSH credentials never reach an answer. Nothing reaches your editor.`,
  };
}

export const NETCONFRPC_CLIENT_PACK = Object.freeze({
  /** NETCONF's words. The noun is REQUEST, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a NETCONF device",
    noun: "request",
    argument: "statement",
    writes:
      "every edit-config, copy-config, delete-config, lock, commit and other operation, and every read of a withheld node: ietf-keystore, ietf-netconf-acm, a nacm:default-deny-all node, a crypt-hash leaf, an ietf-crypto-types secret, a leafref to a withheld node, an unresolved leafref, or a key filter on a withheld leaf",
    reached: "the device",
    defect: "your request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The NETCONF variants. The investigation reads the device through `run_read_query`, and the operations workflow
   * sends no request. A plan (query optimization) or a profile (database assessment) is not something a device has,
   * and the data analysis's tools assume a store of records, so neither is offered: their tools could only refuse. No
   * variant auto-executes: no NETCONF answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the network device this NETCONF server describes, such as its interfaces and their state, its routing, system or protocol configuration, or the YANG modules it implements, that is answered from what the run establishes",
      objective:
        "Your objective is a question about the network device this NETCONF server describes: its configuration and operational state, as its YANG modules model them. Answer it from what you establish.",
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
    reads: netconfrpcReadsPosture,
    widened: netconfrpcReadsPosture,
    handoverTerms: () =>
      "A NETCONF answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
