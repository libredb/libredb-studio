/**
 * The snmpget command language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on SNMP: the boundary is the provider's structural closed table, a client that holds Get, GetNext and
 * GetBulk alone behind the valve that refuses every other PDU. Its answers carry the device's values, never anything
 * of the six withheld security and target modules.
 */
function snmpgetReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per read, over a client that sends only Get, GetNext and GetBulk, with the security and target modules withheld`,
    title: "Agent mode reads the SNMP agent's values with get, next, walk and table, and never writes",
    body: `Agent mode runs SNMP reads it wrote itself, each one of the console's four commands, get, next, walk and table, and answers the device's values as the console renders them, text shown only when it is showable and bytes otherwise in hex, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Six modules are withheld, because they hold community strings, user names and access rules: SNMP-TARGET-MIB, SNMP-NOTIFICATION-MIB, SNMP-PROXY-MIB, SNMP-USER-BASED-SM-MIB, SNMP-VIEW-BASED-ACM-MIB and SNMP-COMMUNITY-MIB; an object inside one is answered withheld and never asked for, and a walk that would reach one is refused. Studio's agent client holds only the Get, GetNext and GetBulk requests, and every datagram passes a check that refuses any other, so it cannot send a Set or a notification. The community never reaches an answer. Nothing reaches your editor.`,
  };
}

export const SNMPGET_CLIENT_PACK = Object.freeze({
  /** SNMP's words. The noun is COMMAND, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an SNMP agent",
    noun: "command",
    argument: "statement",
    writes:
      "every Set and notification, and every read of the security and target modules that hold community strings, user names and access rules",
    reached: "the agent",
    defect: "your command",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The SNMP variants. The investigation reads the agent's values through `run_read_query`, and the operations
   * workflow sends no command. A plan (query optimization) or a profile (database assessment) is not something an
   * agent has, and the data analysis's tools assume a store of records, so neither is offered: their tools could only
   * refuse. No variant auto-executes: no SNMP answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the device this SNMP agent describes, such as its identity and uptime, its interfaces and their counters and state, its IP, TCP and UDP figures, or its storage and processes, that is answered from what the run establishes",
      objective:
        "Your objective is a question about the device this SNMP agent describes: its system group, interfaces, network figures and host resources. Answer it from what you establish.",
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
    reads: snmpgetReadsPosture,
    widened: snmpgetReadsPosture,
    handoverTerms: () =>
      "An SNMP answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
