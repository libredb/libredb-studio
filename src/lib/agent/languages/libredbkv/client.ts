/**
 * The LibreDB command language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on a LibreDB file: the boundary is the handle. Each command opens the file read-only on a handle of its
 * own, which takes no lock and cannot write, so the editor keeps the file and keeps writing while the agent reads. The
 * budgets are counted by this server, and the time budget is checked when a read ends, since a read inside this
 * server's own process cannot be stopped midway; the body says so rather than claiming a deadline.
 */
function libredbkvReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} keys and ${seconds} s per command, enforced by a read-only file handle`,
    title: "Agent mode reads, through a handle that cannot write",
    body: `Agent mode runs LibreDB reads it wrote itself, get, prefix and range, bounded to ${rows} keys each and refused past them rather than cut. Each read opens the file read-only on a handle of its own: it takes no lock, so your editor keeps the file and keeps writing, and no call on it can change the file. A read runs inside this server, so one that outruns ${seconds} seconds is refused when it ends rather than stopped midway. Studio's reader refuses put and delete before the file is opened. Nothing reaches your editor.`,
  };
}

export const LIBREDBKV_CLIENT_PACK = Object.freeze({
  /**
   * LibreDB's words. The noun is COMMAND, the engine's own word for one line of its grammar, and the argument is
   * `statement` because the model writes it as text.
   */
  copy: Object.freeze({
    subject: "a LibreDB database",
    noun: "command",
    argument: "statement",
    writes: "put and delete",
    reached: "the file",
    defect: "your LibreDB command",
    adviceKeys: Object.freeze(["prefix", "range"]),
  }),
  /**
   * The LibreDB variants. The store has no plan, no profile and no index, so the workflows judged on one of those
   * (query optimization, database assessment) are not offered here: their tools could only refuse. What remains reads
   * keys: the investigation and the analysis, each through `run_read_query`, grounded in the inventory captured before
   * the first turn, and the operations workflow, which sends no command. No variant auto-executes: no LibreDB answer is
   * handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the stored keys that is answered from what the run establishes",
      objective: "Your objective is a question about this LibreDB database. Answer it from what you establish.",
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
        "Your objective is a question about the data in this LibreDB database. Establish the answer from the keys you read and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the command that produces the answer" }),
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
    reads: libredbkvReadsPosture,
    widened: libredbkvReadsPosture,
    handoverTerms: () =>
      "A LibreDB answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
