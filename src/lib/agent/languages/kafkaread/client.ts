/**
 * The kafkaread request language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Kafka: the boundary is the provider's structural closed table, a client that holds the Metadata and
 * ListOffsets reads alone. Its answers carry names, counts and offsets only.
 */
function kafkareadReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per read, over a client that holds only Metadata and ListOffsets`,
    title: "Agent mode reads Kafka's topics, partitions, brokers and offsets, over a client that holds only two reads",
    body: `Agent mode runs Kafka metadata reads it wrote itself, each one JSON request for the topic list, the broker list, one topic's partitions or one topic's earliest and end offsets, and answers names, counts and offsets only: topic names, partition and replica counts, leader and replica node ids, broker node ids and racks and the cluster id, never a record's key, value, headers or timestamp, a broker's host and port, a config, a log directory or a consumer group, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. An offset span is reported as a span, never as a message count. Studio's agent client holds only the Metadata request, sent with topic auto-creation off, and the ListOffsets request at the earliest and latest offsets, so it cannot fetch, produce, create or delete a topic, commit an offset or change a config, and it never names an internal topic. Nothing reaches your editor.`,
  };
}

export const KAFKAREAD_CLIENT_PACK = Object.freeze({
  /** Kafka's words. The noun is READ REQUEST, the editor's own word for its JSON, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Kafka cluster",
    noun: "read request",
    argument: "statement",
    writes:
      "every produce, fetch, topic or config change and offset commit, and every read of a record, a config, a log directory or a consumer group",
    reached: "the broker",
    defect: "your read request",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The Kafka variants. Agent mode reads metadata only, so the workflows that need stored values (the data analysis),
   * a plan (query optimization) or a profile (database assessment) are not offered here: their tools could only
   * refuse. What remains reads the cluster's metadata: the investigation, through `run_read_query`, and the operations
   * workflow, which sends no read request. No variant auto-executes: no Kafka answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the cluster's topics, partitions, replicas, brokers or offset ranges, such as which topics are under-replicated or offline, how partitions and leaders are spread over brokers, or how far a topic's offsets reach, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this Kafka cluster's metadata: its topics, partitions, replicas, brokers and offset ranges. Answer it from what you establish.",
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
    reads: kafkareadReadsPosture,
    widened: kafkareadReadsPosture,
    handoverTerms: () =>
      "A Kafka answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
