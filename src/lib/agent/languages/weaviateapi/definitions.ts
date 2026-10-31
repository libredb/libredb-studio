/**
 * The tool definitions the Weaviate request language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readWeaviateapiStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const WEAVIATEAPI_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded Weaviate metadata read against the connection\'s server, written as a REST request line and an optional JSON body: GET /v1/meta, /v1/schema, /v1/schema/{collection}, /v1/schema/{collection}/shards, /v1/schema/{collection}/tenants, /v1/schema/{collection}/tenants/{tenant}, /v1/aliases, /v1/aliases/{alias}, /v1/nodes or /v1/nodes/{collection} (?output=verbose for shard rows), or POST /v1/aggregate/{collection} with an optional {"tenant": "..."} for an object count. Answers carry names, counts and flags only. Object reads, searches, GraphQL, filters, groupBy and every write are refused before anything is sent, and you are told why.',
  inputSchema: readWeaviateapiStatementSchema,
  operationId: "weaviateapi.query.read",
});

const WEAVIATEAPI_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: WEAVIATEAPI_RUN_READ_QUERY,
});

/** The investigation sends requests through the one statement tool; `operations` sends none. */
export const WEAVIATEAPI_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: WEAVIATEAPI_STATEMENT_TOOLS,
});
