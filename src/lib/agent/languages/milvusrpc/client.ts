/**
 * The Milvus request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Milvus: the boundary is the provider's closed table of RPCs, which holds no write the agent can reach,
 * and before every request the server proves the user reads only, by refusing it the user list and naming its roles'
 * grants. Its answers carry metadata only: names, counts and flags, never a stored field value or vector.
 */
function milvusrpcReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per request, as a user the server proves read-only`,
    title: "Agent mode reads Milvus's metadata, as a user the server proves read-only",
    body: `Agent mode runs Milvus reads it wrote itself, the database, collection, schema, statistics, load state, partition, index and alias reads, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Its answers carry names, counts and flags only, never a stored field value or vector. Before every request Studio has the server prove the connection's user reads only: it must be refused the list of users, and every privilege its roles and public grant must be a read, so root, the admin role, a role that writes, loads or releases, and a server with authorization off are refused. Studio's reader refuses queries, gets, searches and every write before anything is sent, so no search runs a function on the server. Nothing reaches your editor.`,
  };
}

export const MILVUSRPC_CLIENT_PACK = Object.freeze({
  /** Milvus's words. The noun is REQUEST, the REST reference's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Milvus database",
    noun: "request",
    argument: "statement",
    writes: "every write, query and search",
    reached: "the server",
    defect: "your Milvus request",
    adviceKeys: Object.freeze(["databases", "collections", "collection", "partitions", "aliases"]),
  }),
  /**
   * The Milvus variants. Agent mode reads metadata only, so the workflows that need stored values (the data analysis),
   * a plan (query optimization) or a profile (database assessment) are not offered here: their tools could only
   * refuse. What remains reads the store's shape and counts: the investigation, through `run_read_query`, grounded in
   * the inventory captured before the first turn, and the operations workflow, which sends no request. No variant
   * auto-executes: no Milvus answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the databases, collections, their fields, indexes, partitions, aliases, load state or row counts that is answered from what the run establishes",
      objective:
        "Your objective is a question about this Milvus database's collections and their counts. Answer it from what you establish.",
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
    reads: milvusrpcReadsPosture,
    widened: milvusrpcReadsPosture,
    handoverTerms: () =>
      "A Milvus answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
