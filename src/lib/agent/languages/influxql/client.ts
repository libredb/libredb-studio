/**
 * The InfluxQL language's client facet: its copy, its workflow variants and its posture, as data a browser bundle may
 * hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on InfluxDB 1.x and 2.x: the boundary is the principal. Before every statement the server is asked to
 * refuse it an administrator's read and a no-op write on every database it lists, so only a principal that reads is
 * ever sent a statement. The deadline is the request's: dropping it ends the server's work.
 */
function influxqlReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per statement, enforced by a principal proved read-only`,
    title: "Agent mode reads, as a principal the server proves cannot write",
    body: `Agent mode runs InfluxQL reads it wrote itself, a SELECT, a SHOW of the catalog or an EXPLAIN of a SELECT, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Before every statement Studio has the server prove the connection's principal reads only: it must be refused an administrator's read and a no-op write on every database it lists, so an administrator, a token that writes or a server with authentication off is refused. Studio's reader refuses INTO, every write and SHOW QUERIES before anything is sent. Nothing reaches your editor.`,
  };
}

export const INFLUXQL_CLIENT_PACK = Object.freeze({
  /** InfluxDB's words. The noun is STATEMENT, InfluxQL's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an InfluxDB database",
    noun: "statement",
    argument: "statement",
    writes: "INTO and every write",
    reached: "the database",
    defect: "your InfluxQL statement",
    adviceKeys: Object.freeze(["SELECT", "SHOW"]),
  }),
  /**
   * The InfluxQL variants. The server composes no plan an agent can be shown before it runs and Studio no catalog
   * read for it, so the workflows judged on one of those (query optimization, database assessment) are not offered
   * here: their tools could only refuse. What remains reads: the investigation and the analysis, each through
   * `run_read_query`, grounded in the inventory captured before the first turn, and the operations workflow, which
   * sends no statement. No variant auto-executes: no InfluxDB answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the stored series that is answered from what the run establishes",
      objective: "Your objective is a question about this InfluxDB database. Answer it from what you establish.",
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
        "Your objective is a question about the data in this InfluxDB database. Establish the answer from the series you read and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the InfluxQL statement that produces the answer" }),
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
    reads: influxqlReadsPosture,
    widened: influxqlReadsPosture,
    handoverTerms: () =>
      "An InfluxDB answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
