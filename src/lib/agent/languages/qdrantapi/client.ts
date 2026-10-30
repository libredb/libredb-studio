/**
 * The Qdrant request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Qdrant: the boundary is the provider's closed table of read requests, which can name no write, and
 * before every request the server proves the key reads only, by refusing two writes that would change nothing. Its
 * answers carry metadata only: names, counts and flags, never a stored payload or vector.
 */
function qdrantapiReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per request, from a key the server proves read-only`,
    title: "Agent mode reads Qdrant's metadata, as a key the server proves read-only",
    body: `Agent mode runs Qdrant reads it wrote itself, the version, collection, alias, count and cluster reads, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Its answers carry names, counts and flags only, never a stored payload or vector. Before every request Studio has the server refuse an empty alias update and an empty point delete on every collection the key lists, so the API key, a JWT that writes any collection, a server with no key configured and a connection with no key are refused. Studio's reader refuses point reads, scrolls, facets, every query and every write before anything is sent, so no inference call is made. Nothing reaches your editor.`,
  };
}

export const QDRANTAPI_CLIENT_PACK = Object.freeze({
  /** Qdrant's words. The noun is REQUEST, the REST reference's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Qdrant database",
    noun: "request",
    argument: "statement",
    writes: "every write, point read and query",
    reached: "the server",
    defect: "your Qdrant request",
    adviceKeys: Object.freeze(["collections", "collection", "aliases"]),
  }),
  /**
   * The Qdrant variants. Agent mode reads metadata only, so the workflows that need stored values (the data
   * analysis), a plan (query optimization) or a profile (database assessment) are not offered here: their tools could
   * only refuse. What remains reads the store's shape and counts: the investigation, through `run_read_query`, grounded
   * in the inventory captured before the first turn, and the operations workflow, which sends no request. No variant
   * auto-executes: no Qdrant answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the collections, their vectors, payload indexes, aliases, shards or point counts that is answered from what the run establishes",
      objective:
        "Your objective is a question about this Qdrant database's collections and their counts. Answer it from what you establish.",
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
    reads: qdrantapiReadsPosture,
    widened: qdrantapiReadsPosture,
    handoverTerms: () =>
      "A Qdrant answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
