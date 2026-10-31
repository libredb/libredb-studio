/**
 * The tool definitions the kafkaread request language's workflows are offered: the statement tool for one metadata
 * read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readKafkareadStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const KAFKAREAD_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded metadata read of a Kafka cluster, written as one JSON object with at most the keys read, topic, after and limit. read is "topics" (each topic\'s partition count, replication factor and offline and under-replicated partitions), "brokers" (each broker\'s node id and rack, and the cluster id), "partitions" (one topic\'s partitions: leader, replicas, in-sync replicas, offline flag) or "offsets" (one topic\'s partitions: earliest offset, end offset and the span between them); "partitions" and "offsets" need "topic". limit is 1 to 500, default 50, and "after" is the last topic name, node id or partition id of the answer before, to read on. A record\'s key, value, headers and timestamp, a broker\'s host and port, configs, log directories and consumer groups are never read. An offset span is how far the offsets reach, not a message count: compaction, transaction markers and retention make the two differ. A request with any other key or read, or a limit past the row budget, is refused rather than answered in part, and you are told why.',
  inputSchema: readKafkareadStatementSchema,
  operationId: "kafkaread.query.read",
});

const KAFKAREAD_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: KAFKAREAD_RUN_READ_QUERY,
});

/** The investigation sends reads through the one statement tool; `operations` sends none. */
export const KAFKAREAD_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: KAFKAREAD_STATEMENT_TOOLS,
});
