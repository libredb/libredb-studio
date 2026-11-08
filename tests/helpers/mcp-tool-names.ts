/**
 * The tool names MCP serves, in the order tools/list answers them, as the tests read them, both from
 * `MCP_TOOL_INPUT_SCHEMAS`' order: the metadata tools, then statement tools in record order.
 *
 * `registeredMcpToolNames` is the build's names: the full handler's registrations, and the list a token that reaches
 * every served engine gets. Each statement tool whose arm serves an engine is in it; a declared statement tool that
 * serves no engine keeps its schema entry and is left out, as registration leaves it out.
 * `listedMcpToolNames` is one token's names: the metadata tools, then each serving arm that serves an engine the token
 * reaches.
 *
 * Its own file rather than a fixture beside the others, so a test that replaces a module before it loads MCP can
 * import this after the replacement.
 */
import { MCP_TOOL_INPUT_SCHEMAS } from "@/lib/mcp/tools";
import { listedStatementArms, MCP_STATEMENT_TOOLS, servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseType } from "@/lib/types";

export function registeredMcpToolNames(): string[] {
  const serving = new Set<string>(servingStatementArms().map((arm) => arm.tool));
  const declared = new Set<string>(MCP_STATEMENT_TOOLS);
  return Object.keys(MCP_TOOL_INPUT_SCHEMAS).filter((name) => !declared.has(name) || serving.has(name));
}

/** The tool names a token that reaches `reached` lists, in its tools/list's order: the metadata tools, then each serving arm that serves a reached engine. */
export function listedMcpToolNames(reached: ReadonlySet<DatabaseType>): string[] {
  const listed = new Set<string>(listedStatementArms(reached).map((arm) => arm.tool));
  const declared = new Set<string>(MCP_STATEMENT_TOOLS);
  return Object.keys(MCP_TOOL_INPUT_SCHEMAS).filter((name) => !declared.has(name) || listed.has(name));
}
