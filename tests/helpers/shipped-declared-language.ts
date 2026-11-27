/**
 * The ids by which a test names a statement language a shipped declaration states as data, and its MCP statement tool:
 * agent mode brands both, so a test reads each from the registry that composes it rather than writing a bare string.
 * It loads the agent's language registries, so a test that substitutes a module they read (tests/unit/lib/agent/
 * declared-language-drive.test.ts) never imports it.
 */
import type { AgentDeclaredLanguageId } from "@/lib/agent/agent-manifest";
import { DECLARED_AGENT_LANGUAGES } from "@/lib/agent/languages/client";
import { AGENT_LANGUAGE_MCP_FACETS, type AgentDeclaredMcpTool } from "@/lib/agent/languages/mcp";

/**
 * Agent mode's id of `name`, a statement language a shipped declaration states agent data for, as the registries
 * compose it (`DECLARED_AGENT_LANGUAGES`): a test names a declared language through it, since the id is branded.
 *
 * @throws {Error} Naming `name`, where no shipped declaration states agent data for it.
 */
export function shippedDeclaredLanguage(name: string): AgentDeclaredLanguageId {
  const declared = DECLARED_AGENT_LANGUAGES.find(({ id }) => id === name);
  if (declared === undefined) throw new Error(`No shipped declaration states agent data for ${JSON.stringify(name)}.`);
  return declared.id;
}

/**
 * MCP's name of the statement tool `name`'s shipped declaration states (`AGENT_LANGUAGE_MCP_FACETS`): a test names a
 * declared tool through it, since the name is branded.
 *
 * @throws {Error} Naming `name`, where its data states no MCP statement tool.
 */
export function shippedDeclaredMcpTool(name: string): AgentDeclaredMcpTool {
  const facet = AGENT_LANGUAGE_MCP_FACETS[shippedDeclaredLanguage(name)];
  if (facet === null)
    throw new Error(`The shipped declaration of ${JSON.stringify(name)} states no MCP statement tool.`);
  return facet.tool as AgentDeclaredMcpTool;
}
