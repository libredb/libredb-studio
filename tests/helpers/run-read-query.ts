/**
 * The SQL language's MCP tool, `run_read_query`, as the tests read it: the arm MCP builds from the SQL facet, found by
 * its tool. MCP itself names no language's tool, so this lookup lives with the tests, which may.
 *
 * The constants are the bundled set's arm, read when this module loads with nothing installed; `runReadQuery` reads the
 * arm of the catalog installed when it is called, as the registered tool does.
 */
import type { ToolResult } from "@/lib/mcp/output";
import type { McpToolCall } from "@/lib/mcp/context";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

const RUN_READ_QUERY_ARM = mcpStatementArm("run_read_query");

export const RunReadQueryInputSchema = RUN_READ_QUERY_ARM.inputSchema;
export const RUN_READ_QUERY_TYPES: readonly DatabaseType[] = SHIPPED_DATABASE_TYPES.filter((type) =>
  RUN_READ_QUERY_ARM.types.some((id) => id === type),
);
export const RUN_READ_QUERY_ENGINES = RUN_READ_QUERY_ARM.engines;
export const RUN_READ_QUERY_DESCRIPTION = RUN_READ_QUERY_ARM.description;

export function runReadQuery(args: McpStatementInput, call: McpToolCall): Promise<ToolResult> {
  return runStatement(mcpStatementArm("run_read_query"), args, call);
}
