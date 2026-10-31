/**
 * The rabbitread request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on RabbitMQ: the boundary is the provider's structural closed table, since a read permission also grants
 * a take and a purge, so no credential can be one. Its answers carry each message's offset and body size only.
 */
function rabbitreadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per read, over a client that cannot take a message`,
    title: "Agent mode reads RabbitMQ streams' offsets and sizes, over a client that cannot take a message",
    body: `Agent mode runs RabbitMQ stream reads it wrote itself, each one read request naming a virtual host, a stream, where to start and how many messages, and answers each message's offset and body size, never its body, headers, properties or routing key, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut; a read that stops before its limit for any reason but the stream's end is refused rather than answered in part. The tree's virtual host, stream, queue and exchange names reach it as names. A read permission in RabbitMQ also lets an account take and purge messages, so no account can be the boundary: Studio's read client has no way to take, publish, purge or declare, a read asks the management API for the object's type and refuses a classic or quorum queue before any frame, and its consume carries a stream offset the broker refuses on any queue. Nothing reaches your editor.`,
  };
}

export const RABBITREAD_CLIENT_PACK = Object.freeze({
  /** RabbitMQ's words. The noun is READ REQUEST, the editor's own word for its JSON, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a RabbitMQ broker",
    noun: "read request",
    argument: "statement",
    writes:
      "every take, publish, purge or declare, and every read of a message's body, headers, properties or routing key",
    reached: "the broker",
    defect: "your read request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The RabbitMQ variants. Agent mode reads metadata only, so the workflows that need stored values (the data
   * analysis), a plan (query optimization) or a profile (database assessment) are not offered here: their tools could
   * only refuse. What remains reads streams' offsets and sizes: the investigation, through `run_read_query`, and the
   * operations workflow, which sends no read request. No variant auto-executes: no RabbitMQ answer is handed to the
   * editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the broker's streams, how many messages a stream or a range of it holds, where they sit by offset or time, or how large their bodies are, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this RabbitMQ broker's streams: their message counts, offsets and body sizes. Answer it from what you establish.",
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
    reads: rabbitreadReadsPosture,
    widened: rabbitreadReadsPosture,
    handoverTerms: () =>
      "A RabbitMQ answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
