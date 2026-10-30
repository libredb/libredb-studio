/**
 * The tool definitions the Milvus request language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readMilvusrpcStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const MILVUSRPC_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded Milvus metadata read against the connection\'s database, written as a Milvus REST v2 request line and an optional JSON body: POST /v2/vectordb/databases/list, databases/describe, collections/list, collections/describe, collections/get_stats or collections/get_load_state with {"collectionName": "..."}, partitions/list, indexes/list, indexes/describe with an indexName, aliases/list or aliases/describe with an aliasName. Answers carry names, counts and flags only. Queries, gets, searches, every write, Load and Release, and a dbName naming another database are refused before anything is sent, and you are told why.',
  inputSchema: readMilvusrpcStatementSchema,
  operationId: "milvusrpc.query.read",
});

const MILVUSRPC_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: MILVUSRPC_RUN_READ_QUERY,
});

/** The investigation sends requests through the one statement tool; `operations` sends none. */
export const MILVUSRPC_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: MILVUSRPC_STATEMENT_TOOLS,
});
