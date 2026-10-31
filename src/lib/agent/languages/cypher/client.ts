/**
 * The Cypher language's client facet: its copy, its workflow variants and its posture, as data a browser bundle may
 * hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Neo4j Enterprise Edition: the boundary is the user. Before every statement the server is asked who the
 * user is and what its roles grant, so only a user that reads, cannot LOAD and can execute no extension is ever sent a
 * statement, in a READ session. The deadline is the transaction's: the server ends the work.
 */
function cypherReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per statement, enforced by a user proved read-only`,
    title: "Agent mode reads, as a user the server proves cannot write",
    body: `Agent mode runs Cypher reads it wrote itself, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Before every statement Studio has the server prove the connection's user reads only: Neo4j Enterprise Edition, every privilege of every role a read, no LOAD, and no procedure or function beyond the server's built-ins, so an administrator, a user that writes or loads files and URLs, a server with an extension the user can run, and Community Edition are refused. Studio's reader refuses writes, LOAD CSV, USE and comments before anything is sent. Nothing reaches your editor.`,
  };
}

export const CYPHER_CLIENT_PACK = Object.freeze({
  /** Neo4j's words. The noun is STATEMENT, Cypher's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Neo4j database",
    noun: "statement",
    argument: "statement",
    writes: "every write and LOAD CSV",
    reached: "the database",
    defect: "your Cypher statement",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Cypher variants. The agent is shown no plan before a statement runs and Studio composes no catalog read for
   * it, so the workflows judged on one of those (query optimization, database assessment) are not offered here: their
   * tools could only refuse. What remains reads: the investigation and the analysis, each through `run_read_query`,
   * grounded in the inventory captured before the first turn, and the operations workflow, which sends no statement.
   * No variant auto-executes: no Neo4j answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the stored graph that is answered from what the run establishes",
      objective: "Your objective is a question about this Neo4j database. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    operations: OPERATIONS_VARIANT,
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "present_answer", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the stored data whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about the data in this Neo4j database. Establish the answer from the nodes and relationships you read and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the Cypher statement that produces the answer" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-data-analysis.1",
    }),
  }),
  planEstimateOperation: null,
  evidenceEvents: Object.freeze({}),
  shortfallSentences: Object.freeze({}),
  readingRefusalHeadlines: Object.freeze({}),
  requirements: Object.freeze({}),
  posture: Object.freeze({
    reads: cypherReadsPosture,
    widened: cypherReadsPosture,
    handoverTerms: () =>
      "A Neo4j answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
