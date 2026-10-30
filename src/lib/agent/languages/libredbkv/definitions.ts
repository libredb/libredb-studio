/**
 * The tool definitions the LibreDB command language's workflows are offered: the statement tool for one read command.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readLibredbkvStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const LIBREDBKV_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded read-only LibreDB command, on one line: get <key> reads one key, prefix <p> reads every key that starts with p, and range <start> <end> reads the keys from start up to but not including end. Every key is matched exactly, with no glob and no wildcard; quote a key that holds a space. put, delete and anything else are refused before the file is opened, and you are told why.",
  inputSchema: readLibredbkvStatementSchema,
  operationId: "libredbkv.query.read",
});

const LIBREDBKV_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: LIBREDBKV_RUN_READ_QUERY,
});

/** Every LibreDB workflow that sends a command shares the one statement tool; `operations` sends none. */
export const LIBREDBKV_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: LIBREDBKV_STATEMENT_TOOLS,
  "data-analysis": LIBREDBKV_STATEMENT_TOOLS,
});
