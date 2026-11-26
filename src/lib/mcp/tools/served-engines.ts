import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import {
  GRANTED_AGENT_STATEMENT_LANGUAGE,
  GRANTED_MCP_EXPOSABLE,
  GRANTED_MCP_STATEMENT_READ,
  GRANTED_AGENT_EXECUTION_ENGINES,
} from "@/lib/db/claim-grants";
import type { DatabaseType } from "@/lib/types";

/**
 * The one served-engine resolver of the MCP statement tools. A tool's served set, its
 * description and its call-time gate all read this, so a tool cannot name an engine it refuses or run on one it does
 * not name, and no type-id table is read outside the records below.
 *
 * An engine is served when Studio's review record of the engines agent and MCP statements run on
 * (`GRANTED_AGENT_EXECUTION_ENGINES`) lists it, Studio's grant `GRANTED_MCP_EXPOSABLE` offers it to MCP,
 * `GRANTED_MCP_STATEMENT_READ` opens statement reads on it, and its granted statement language,
 * `GRANTED_AGENT_STATEMENT_LANGUAGE`, is the tool's. The second grant is what keeps an engine whose agent PR has
 * merged closed to MCP until its own change opens it. The acquisition and the core read path read the first record
 * again at run time, so an engine off it is refused by name there too.
 */
export interface McpExposure {
  readonly executes: readonly DatabaseType[];
  readonly exposable: typeof GRANTED_MCP_EXPOSABLE;
  readonly statementRead: typeof GRANTED_MCP_STATEMENT_READ;
  readonly language: typeof GRANTED_AGENT_STATEMENT_LANGUAGE;
}

const SHIPPED_EXPOSURE: McpExposure = {
  executes: GRANTED_AGENT_EXECUTION_ENGINES,
  exposable: GRANTED_MCP_EXPOSABLE,
  statementRead: GRANTED_MCP_STATEMENT_READ,
  language: GRANTED_AGENT_STATEMENT_LANGUAGE,
};

/** The engines an MCP tool whose statements are in `language` serves, in agent execution order, which is catalog order. */
export function mcpStatementEngines(
  language: AgentStatementLanguageId,
  exposure: McpExposure = SHIPPED_EXPOSURE,
): readonly DatabaseType[] {
  return exposure.executes.filter(
    (type) => exposure.exposable[type] && exposure.statementRead[type] && exposure.language[type] === language,
  );
}
