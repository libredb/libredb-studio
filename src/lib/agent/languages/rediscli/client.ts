/**
 * The Redis command language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Redis: the boundary is the provider's closed table of metadata reads, which holds no write and no
 * read of a key name or a value, and before every command the server is asked to refuse the ACL user a set of write
 * probes that change nothing, each as a command the user does not hold. Its answers carry counts, types and sizes only.
 */
function rediscliReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per command, as an ACL user the server refuses writes`,
    title: "Agent mode reads Redis's metadata, as an ACL user the server refuses writes",
    body: `Agent mode runs Redis reads it wrote itself, the database's key count and, for one key a command names, its type, existence, time to live, length, encoding and memory use, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Key names count as stored values, so it never lists keys and never reads a value, field or member. Before every command, on that command's own connection, the server must refuse the connection's ACL user write, admin, dangerous, scripting and pubsub probes that change nothing, each as a command the user does not hold, so the default user, a connection naming no user and a user holding any probed command, even on its own key pattern only, are refused; a write the probes leave out is stopped by the reader, which sends none. Studio's reader refuses every other command before anything is sent. Nothing reaches your editor.`,
  };
}

export const REDISCLI_CLIENT_PACK = Object.freeze({
  /** Redis's words. The noun is COMMAND, the documentation's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Redis database",
    noun: "command",
    argument: "statement",
    writes: "every write, and every read of a key name or a value",
    reached: "the server",
    defect: "your Redis command",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Redis variants. Agent mode reads metadata only, so the workflows that need stored values (the data analysis),
   * a plan (query optimization) or a profile (database assessment) are not offered here: their tools could only
   * refuse. What remains reads the database's size and named keys' shape: the investigation, through
   * `run_read_query`, and the operations workflow, which sends no command. No variant auto-executes: no Redis answer is
   * handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the database's key count, or about the type, existence, expiry, length, encoding or memory use of keys the question names, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this Redis database's size or about keys it names. Answer it from what you establish.",
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
    reads: rediscliReadsPosture,
    widened: rediscliReadsPosture,
    handoverTerms: () =>
      "A Redis answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
