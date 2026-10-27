import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

/**
 * The one served-engine resolver of the MCP statement tools (all-providers design 6, V12). A tool's served set, its
 * description and its call-time gate all read this, so a tool cannot name an engine it refuses or run on one it does
 * not name, and no type-id table is read outside the records below.
 *
 * An engine is served when agent mode executes statements on it, `MCP_EXPOSABLE` offers it to MCP, `MCP_STATEMENT_READ`
 * opens statement reads on it, and its statement language is the tool's. The second record is what keeps an engine
 * whose agent PR has merged closed to MCP until its own change opens it.
 */
export interface McpExposure {
  readonly executes: readonly DatabaseType[];
  readonly exposable: Readonly<Record<DatabaseType, boolean>>;
  readonly statementRead: Readonly<Record<DatabaseType, boolean>>;
  readonly language: Readonly<Record<DatabaseType, AgentStatementLanguageId | null>>;
}

const SHIPPED_EXPOSURE: McpExposure = {
  executes: AGENT_EXECUTION_ENGINES,
  exposable: MCP_EXPOSABLE,
  statementRead: MCP_STATEMENT_READ,
  language: AGENT_STATEMENT_LANGUAGE,
};

/** The engines an MCP tool whose statements are in `language` serves, in agent execution order. */
export function mcpStatementEngines(
  language: AgentStatementLanguageId,
  exposure: McpExposure = SHIPPED_EXPOSURE,
): readonly DatabaseType[] {
  return exposure.executes.filter(
    (type) => exposure.exposable[type] && exposure.statementRead[type] && exposure.language[type] === language,
  );
}
