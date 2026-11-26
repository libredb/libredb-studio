import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseType } from "@/lib/types";

/**
 * The one served-engine resolver of the MCP statement tools. A tool's served set, its
 * description and its call-time gate all read this, so a tool cannot name an engine it refuses or run on one it does
 * not name, and no type-id table is read outside the engine records below.
 *
 * An engine is served when its engine record (`servedEngineRecord`) grants agent execution (Studio's review record of
 * the engines agent and MCP statements run on), grants `exposable`, which offers it to MCP, grants `statementRead`,
 * which opens statement reads on it, and grants the tool's statement language. The third grant is what keeps an engine
 * whose agent PR has merged closed to MCP until its own change opens it. The acquisition and the core read path read
 * the first grant again at run time, so an engine without it is refused by name there too.
 *
 * Only the engines the legacy adapter serves are asked, in catalog order (`SHIPPED_DATABASE_TYPES`): every MCP open
 * refuses a package's engine before any grant is read, and `MCP_STATEMENT_ARMS` reads this set once, when its module
 * loads, so a set that held a package's engine would depend on whether boot had installed the catalog by then. Opening
 * MCP to package engines composes the set from the installed catalog (M5).
 */
export type McpExposure = (
  type: DatabaseType,
) => Pick<EngineGrants, "agentExecution" | "exposable" | "statementRead" | "statementLanguage">;

/**
 * The engines an MCP tool whose statements are in `language` serves, in catalog order, read when called; `exposure`,
 * the reader of an engine's grants, defaults to the engine record's and is injectable for the tests.
 */
export function mcpStatementEngines(
  language: AgentStatementLanguageId,
  exposure: McpExposure = (type) => servedEngineRecord(type).grants,
): readonly DatabaseType[] {
  return SHIPPED_DATABASE_TYPES.filter((type) => {
    const grants = exposure(type);
    return grants.agentExecution && grants.exposable && grants.statementRead && grants.statementLanguage === language;
  });
}
