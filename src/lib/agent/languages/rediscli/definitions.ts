/**
 * The tool definitions the Redis command language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readRediscliStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const REDISCLI_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded Redis metadata read against the connection's database, written as one Redis command on one line: DBSIZE, or for one key you name TYPE, EXISTS, TTL, PTTL, STRLEN, LLEN, HLEN, SCARD, ZCARD, XLEN, OBJECT ENCODING or MEMORY USAGE (with SAMPLES 1 to 5). Double-quote a key that holds a space. Answers carry counts, types and sizes only. Key names and stored values are withheld, so SCAN, KEYS, INFO, every read of a value, field or member, and every write are refused before anything is sent, and you are told why.",
  inputSchema: readRediscliStatementSchema,
  operationId: "rediscli.query.read",
});

const REDISCLI_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: REDISCLI_RUN_READ_QUERY,
});

/** The investigation sends commands through the one statement tool; `operations` sends none. */
export const REDISCLI_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: REDISCLI_STATEMENT_TOOLS,
});
