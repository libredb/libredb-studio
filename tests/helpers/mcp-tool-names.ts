/**
 * The tool names this build registers, in the order tools/list answers them, as the tests read them: the metadata
 * tools, then each statement tool whose arm serves an engine, in record order (`MCP_TOOL_INPUT_SCHEMAS` is that
 * order). A declared statement tool that serves no engine keeps its schema entry and is left out, as registration
 * leaves it out.
 *
 * Its own file rather than a fixture beside the others, so a test that replaces a module before it loads MCP can
 * import this after the replacement.
 */
import { MCP_TOOL_INPUT_SCHEMAS } from "@/lib/mcp/tools";
import { MCP_STATEMENT_TOOLS, servingStatementArms } from "@/lib/mcp/tools/statement-arms";

export function registeredMcpToolNames(): string[] {
  const serving = new Set<string>(servingStatementArms().map((arm) => arm.tool));
  const declared = new Set<string>(MCP_STATEMENT_TOOLS);
  return Object.keys(MCP_TOOL_INPUT_SCHEMAS).filter((name) => !declared.has(name) || serving.has(name));
}
