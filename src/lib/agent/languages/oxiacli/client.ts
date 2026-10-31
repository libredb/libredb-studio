/**
 * The oxiacli command language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Oxia: the boundary is the provider's closed table of metadata reads, sent over a gRPC stub that holds
 * only reads, since Oxia has no authorization to prove a reader by. Its answers carry names, counts and sizes only.
 */
function oxiacliReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per command, over a client that holds only reads`,
    title: "Agent mode reads Oxia's metadata, over a client that holds only reads",
    body: `Agent mode runs Oxia reads it wrote itself, the namespace's shard and leader counts, for one key a command names its existence, version, times, value size and whether it is ephemeral, and the count of every key in the namespace, never their names, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut; a namespace holding more than ${rows} keys is refused rather than counted in part, and a count over a range or prefix a command names is refused, since narrower counts would reveal key names. Key names count as stored values, so it never lists keys, reads a value or follows notifications. Oxia has no authorization, so no reader can be proved: Studio's client holds only the four read calls and sends nothing in another namespace, under a partition key, by a secondary index or by comparison, and its reader refuses every other command before anything is sent. Nothing reaches your editor.`,
  };
}

export const OXIACLI_CLIENT_PACK = Object.freeze({
  /** Oxia's words. The noun is COMMAND, the oxia CLI's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an Oxia namespace",
    noun: "command",
    argument: "statement",
    writes: "every write, and every read of a key name or a value",
    reached: "the namespace",
    defect: "your oxia command",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Oxia variants. Agent mode reads metadata only, so the workflows that need stored values (the data analysis),
   * a plan (query optimization) or a profile (database assessment) are not offered here: their tools could only
   * refuse. What remains reads the shard map and named keys' metadata: the investigation, through `run_read_query`,
   * and the operations workflow, which sends no command. No variant auto-executes: no Oxia answer is handed to the
   * editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the namespace's shards and leaders, about how many keys the namespace holds, or about the existence, version, times, value size or ephemeral state of keys the question names, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this Oxia namespace's shards, key counts or keys it names. Answer it from what you establish.",
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
    reads: oxiacliReadsPosture,
    widened: oxiacliReadsPosture,
    handoverTerms: () =>
      "An Oxia answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
