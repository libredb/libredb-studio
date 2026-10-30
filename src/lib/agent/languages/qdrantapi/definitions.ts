/**
 * The tool definitions the Qdrant request language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readQdrantapiStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const QDRANTAPI_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded Qdrant metadata read against the connection\'s server, written as a REST request line and an optional JSON body: GET /, /collections, /collections/{collection}, /collections/{collection}/exists, /collections/{collection}/aliases, /collections/{collection}/cluster or /aliases, or POST /collections/{collection}/points/count with an optional {"exact": true} for a point count. Answers carry names, counts and flags only. Point reads, scrolls, facets, every query, a count filter and every write are refused before anything is sent, and you are told why.',
  inputSchema: readQdrantapiStatementSchema,
  operationId: "qdrantapi.query.read",
});

const QDRANTAPI_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: QDRANTAPI_RUN_READ_QUERY,
});

/** The investigation sends requests through the one statement tool; `operations` sends none. */
export const QDRANTAPI_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: QDRANTAPI_STATEMENT_TOOLS,
});
