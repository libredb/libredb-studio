import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { agentLanguageMcpFacets } from "@/lib/agent/languages/mcp";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { readOnlyStatementRecordRefusal } from "@/lib/db/factory";
import { type EngineRecord, servedEngines } from "@/lib/db/server-catalog";

/**
 * The one served-engine resolver of the MCP statement tools. A tool's served set, its
 * description and its call-time gate all read this, so a tool cannot name an engine it refuses or run on one it does
 * not name, and no type-id table is read outside the engine records below.
 *
 * An engine is served when its engine record grants agent execution (Studio's review record of the engines agent and
 * MCP statements run on), grants `exposable`, which offers it to MCP, grants `statementRead`, which opens statement
 * reads on it, and grants the tool's statement language, and when the tool can send its statements there. The third
 * grant is what keeps an engine whose agent PR has merged closed to MCP until its own change opens it. The acquisition
 * and the core read path read the agent execution grant again at run time, so an engine without it is refused by name
 * there too.
 *
 * Where the tool can send its statements is read from the record itself:
 * - a record that offers the execution profiles (`offers.executionProfiles`), every legacy record, is served by the
 *   tool of its language, which acquires its provider under the agent-read-only profile;
 * - a provider package's record, which offers none, is served only by a tool fenced by its language's own admission
 *   (the language's MCP facet's `fence`), since `run_read_query`'s fence, paging and refusal texts read Studio's
 *   accepted-forms row of a legacy engine; only where its package takes a read-only execute
 *   (`offers.readOnlyStatements`), since its statements go through the read-only statement session its package opens;
 *   only where the opener refuses none of its connections by its record (`readOnlyStatementRecordRefusal` in
 *   src/lib/db/factory.ts: read roots, one session); and only where its record requires no agent credential, since
 *   MCP's open refuses every connection of such a package record (`assertAgentCredentialWhereRequired` in ../context).
 *   So no statement tool lists an engine it could only refuse for every connection.
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
 * records, and `exposure`, the reader of an engine's four MCP grants, to the engine record's, both injectable for the
 * tests. The offers, the opener's record refusals and the agent credential grant are read from the record itself.
 */
export function mcpStatementEngines(
  language: AgentStatementLanguageId,
  engines: ReadonlyMap<string, EngineRecord> = servedEngines(),
  exposure: McpExposure = (engine) => engine.grants,
): readonly EngineRecord[] {
  const fence = agentLanguageMcpFacets()[language]?.fence;
  return [...engines.values()].filter((engine) => {
    const grants = exposure(engine);
    if (!(grants.agentExecution && grants.exposable && grants.statementRead && grants.statementLanguage === language)) {
      return false;
    }
    if (engine.offers.executionProfiles) return true;
    return (
      fence === "language-admission" &&
      engine.offers.readOnlyStatements &&
      readOnlyStatementRecordRefusal(engine) === null &&
      !engine.grants.agentCredentialRequired
    );
  });
}
