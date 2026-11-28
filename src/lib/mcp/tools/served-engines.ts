import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { type EngineRecord, servedEngines } from "@/lib/db/server-catalog";

/**
 * The one served-engine resolver of the MCP statement tools. A tool's served set, its
 * description and its call-time gate all read this, so a tool cannot name an engine it refuses or run on one it does
 * not name, and no type-id table is read outside the engine records below.
 *
 * An engine is served when its engine record offers the execution profiles (`offers.executionProfiles`), which the
 * statement tools acquire under, grants agent execution (Studio's review record of the engines agent and MCP statements
 * run on), grants `exposable`, which offers it to MCP, grants `statementRead`, which opens statement reads on it, and
 * grants the tool's statement language. The third grant is what keeps an engine whose agent PR has merged closed to MCP
 * until its own change opens it. The acquisition and the core read path read the agent execution grant again at run
 * time, so an engine without it is refused by name there too.
 *
 * A package engine's record offers no execution profile, since its session opens through its package and MCP opens no
 * read-only statement session through a package yet, so no statement tool lists an engine it could only refuse.
 *
 * Every record the server serves is asked, in catalog order (`servedEngines`): the installed catalog's records, or the
 * legacy records with nothing installed. The statement tools read this set through one accessor that composes it after
 * boot, once per installed catalog (`mcpStatementSurface` in ./statement-arms), never when a module loads.
 */
export type McpExposure = (
  engine: EngineRecord,
) => Pick<EngineGrants, "agentExecution" | "exposable" | "statementRead" | "statementLanguage">;

/**
 * The records of `engines` an MCP tool whose statements are in `language` serves, in their order and by reference, read
 * when called, so a caller takes each engine's id and display name from one record; `engines` defaults to the served
 * records, and `exposure`, the reader of an engine's grants, to the engine record's, both injectable for the tests.
 */
export function mcpStatementEngines(
  language: AgentStatementLanguageId,
  engines: ReadonlyMap<string, EngineRecord> = servedEngines(),
  exposure: McpExposure = (engine) => engine.grants,
): readonly EngineRecord[] {
  return [...engines.values()].filter((engine) => {
    if (!engine.offers.executionProfiles) return false;
    const grants = exposure(engine);
    return grants.agentExecution && grants.exposable && grants.statementRead && grants.statementLanguage === language;
  });
}
