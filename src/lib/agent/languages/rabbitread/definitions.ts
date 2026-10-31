/**
 * The tool definitions the rabbitread request language's workflows are offered: the statement tool for one stream read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readRabbitreadStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const RABBITREAD_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded read of one RabbitMQ stream, written as one JSON object with the keys vhost, stream, from and limit and no other: {"vhost": "/", "stream": "orders", "from": "first", "limit": 50}. from is "first", "last" (the broker\'s last stored chunk), "next", {"offset": n}, {"timestamp": "<ISO-8601 with a zone>"} or {"age": "<n><unit>"}, and limit is 1 to 500, default 50. Each message answers one row, its offset and its body size, and nothing else: a message\'s body, headers, properties and routing key are withheld. Only a stream is read: a classic or quorum queue is refused, since reading it would remove its messages. A request with any other key, a limit past the row budget, or a read that stops before its limit for any reason but the stream\'s end is refused rather than answered in part, and you are told why.',
  inputSchema: readRabbitreadStatementSchema,
  operationId: "rabbitread.query.read",
});

const RABBITREAD_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: RABBITREAD_RUN_READ_QUERY,
});

/** The investigation sends reads through the one statement tool; `operations` sends none. */
export const RABBITREAD_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: RABBITREAD_STATEMENT_TOOLS,
});
