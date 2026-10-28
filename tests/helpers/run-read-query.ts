/**
 * The SQL language's MCP tool, `run_read_query`, as the tests read it: the arm MCP builds from the SQL facet, found by
 * its tool. MCP itself names no language's tool, so this lookup lives with the tests, which may.
 */
import type { ToolResult } from "@/lib/mcp/output";
import type { McpToolCall } from "@/lib/mcp/context";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseType } from "@/lib/types";

const RUN_READ_QUERY_ARM = mcpStatementArm("run_read_query");

export const RunReadQueryInputSchema = RUN_READ_QUERY_ARM.inputSchema;
export const RUN_READ_QUERY_TYPES: readonly DatabaseType[] = RUN_READ_QUERY_ARM.types;
export const RUN_READ_QUERY_ENGINES = RUN_READ_QUERY_ARM.engines;
export const RUN_READ_QUERY_DESCRIPTION = RUN_READ_QUERY_ARM.description;

export function runReadQuery(args: McpStatementInput, call: McpToolCall): Promise<ToolResult> {
  return runStatement(RUN_READ_QUERY_ARM, args, call);
}
