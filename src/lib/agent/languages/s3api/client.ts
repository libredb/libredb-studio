/**
 * The s3api command language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on S3: the boundary is the provider's structural closed table, a client that holds six reads over a
 * transport that sends GET and HEAD only. Its answers carry names, counts and flags only.
 */
function s3apiReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per read, over a client that holds only GET and HEAD reads of bucket metadata`,
    title: "Agent mode reads S3 bucket names, totals and named objects' metadata, never an object key or its contents",
    body: `Agent mode runs S3 metadata reads it wrote itself, each one AWS CLI command for the bucket list, one bucket's existence, region, location or versioning status, one whole bucket's object count and total size, or one object the request names in full, and answers names, counts and flags only: bucket names and creation times, regions, versioning status, totals, and a named object's existence, size, last-modified time and storage class, never an object key it was not given, a body, user metadata, a tag, an ETag, a version id, an owner, an ACL, a policy or the endpoint, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. A bucket is counted whole and never by prefix, since narrower counts would reveal key names. Studio's agent client holds only those six reads, each a GET or a HEAD, so it cannot read or list an object, write, delete or sign a URL. Nothing reaches your editor.`,
  };
}

export const S3API_CLIENT_PACK = Object.freeze({
  /** S3's words. The noun is COMMAND, the console's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an S3 store",
    noun: "command",
    argument: "statement",
    writes:
      "every write, delete, copy and presigned URL, and every read of an object, its tags or versions, or a listing of keys",
    reached: "the server",
    defect: "your command",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The S3 variants. Agent mode reads metadata only, so the workflows that need stored values (the data analysis),
   * a plan (query optimization) or a profile (database assessment) are not offered here: their tools could only
   * refuse. What remains reads the store's metadata: the investigation, through `run_read_query`, and the operations
   * workflow, which sends no command. No variant auto-executes: no S3 answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the store's buckets, their regions and versioning, how many objects a bucket holds and how large it is, or whether one named object exists and how large it is, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this S3 store's metadata: its buckets, their regions and versioning, a bucket's object count and total size, and the metadata of objects the question names. Answer it from what you establish.",
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
    reads: s3apiReadsPosture,
    widened: s3apiReadsPosture,
    handoverTerms: () =>
      "An S3 answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
