/**
 * The fsquery statement language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Firestore: the boundary is the provider's structural closed table, a client that holds three reads
 * over a request table that admits reads only. Its answers carry collection ids, counts, flags and times only.
 */
function fsqueryReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per read, each read charged to the run's read allowance, over a client that holds only collection id listings, whole-collection counts and named-document times`,
    title:
      "Agent mode reads Firestore collection ids, whole-collection counts and named documents' times, never a document id, a field or a value",
    body: `Agent mode runs Firestore metadata reads it wrote itself, each one statement for the root collection ids, the subcollection ids of one document the request names in full, one whole collection's or collection group's document count, or whether one document the request names in full exists and when it was created and last updated, and answers collection ids, counts, flags and times only, never a document id or path it was not given, a field name or a field value, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. A collection is counted whole, never through a filter, an order, a cursor, an offset, a limit or a projection, since narrower counts would reveal stored values. Firestore bills every read, so each one, the grounding's collection id listings included, is charged to the run's read allowance before it is sent and refused once the allowance is spent. Studio's agent client holds only three kinds of request, a collection id listing, a count that nothing narrows and a read of one named document's times, so it cannot query documents, list document ids, read a field, run an aggregation over values, explain a query or write. Nothing reaches your editor.`,
  };
}

export const FSQUERY_CLIENT_PACK = Object.freeze({
  /** Firestore's words. The noun is STATEMENT, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Firestore database",
    noun: "statement",
    argument: "statement",
    writes:
      "every write and transaction, and every query, listing or read that returns documents, document ids or field values",
    reached: "the server",
    defect: "your statement",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Firestore variants. Agent mode reads metadata only, so the workflows that need stored values (the data
   * analysis), a plan (query optimization) or a profile (database assessment) are not offered here: their tools could
   * only refuse. What remains reads the database's metadata: the investigation, through `run_read_query`, and the
   * operations workflow, which sends no statement. No variant auto-executes: no Firestore answer is handed to the
   * editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the database's collections, their subcollections, how many documents a whole collection holds, or whether one named document exists and when it was created or last updated, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this Firestore database's metadata: its collections and subcollections, a whole collection's document count, and the existence and times of documents the question names. Answer it from what you establish.",
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
    reads: fsqueryReadsPosture,
    widened: fsqueryReadsPosture,
    handoverTerms: () =>
      "A Firestore answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
