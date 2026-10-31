/**
 * The modbusread request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Modbus: the boundary is the provider's structural closed table, the request builders of Read Coils,
 * Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification alone, behind the
 * valve that refuses every other function code before it is sent. Its answers carry the device's values, which Modbus
 * guards with no credential; what the body adds is the pacing a device serving one client at a time needs.
 */
function modbusreadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per read, one read at a time per device, over a client that sends only Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification`,
    title: "Agent mode reads the Modbus device's coils, inputs, registers and identification objects, and never writes",
    body: `Agent mode runs Modbus reads it wrote itself, each one of the console's JSON read requests: points the connection's register map names, one block of one table, or the device identification objects. It answers the device's values as the console renders them, numbers and bits decoded as the register map declares them and identification objects as text only when their bytes are text, in hex otherwise, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Agent reads of one device never overlap, across every run on this server, and Studio waits one second after each before the next one dials, so the plant's own client can reach a device that serves one client at a time; one run sends at most 64 requests to Modbus devices. Studio's agent client builds only Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification, and every frame passes a check that refuses any other function code before it is sent, so it cannot write. Nothing reaches your editor.`,
  };
}

export const MODBUSREAD_CLIENT_PACK = Object.freeze({
  /** Modbus's words. The noun is REQUEST, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Modbus device",
    noun: "request",
    argument: "statement",
    writes: "every write function code, every diagnostic and every file or FIFO record request",
    reached: "the device",
    defect: "your request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Modbus variants. The investigation reads the device through `run_read_query`, and the operations workflow
   * sends no statement. A plan (query optimization) or a profile (database assessment) is not something a device
   * has, and the data analysis's tools assume a store of records, so neither is offered: their tools could only
   * refuse. No variant auto-executes: no Modbus answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the Modbus device this connection reads, such as the current values of the points its register map names, a block of its coils, inputs or registers, or its identification objects, that is answered from what the run establishes",
      objective:
        "Your objective is a question about the Modbus device this connection reads: the points its register map names, its coils, inputs and registers, and its identification. Answer it from what you establish.",
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
    reads: modbusreadReadsPosture,
    widened: modbusreadReadsPosture,
    handoverTerms: () =>
      "A Modbus answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
