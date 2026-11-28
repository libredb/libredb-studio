/**
 * The MCP facet of a statement language an engine declares as data (`statementLanguageData.agent.mcp` of its
 * declaration), composed from the language's declared MCP statement tool, so the language needs no module of its own
 * under `languages/<id>/` for MCP to serve it. `mcp.ts` holds it beside the module languages' facets, and the MCP
 * module builds its statement arm from it as from any other facet.
 *
 * Studio fixes everything a declared JSON request language's MCP facet holds besides its tool's name, its
 * `holdsNoTables` flag and its words, the restrictive choice each time: the statement arrives as a non-empty string
 * under `statement`; the tool takes no `database` key and no offset, refuses an input key it does not name, and is
 * fenced by the language's own admission, its declared request form; it states no least timeout, so the shared least
 * holds; its answers carry none of the provider's warnings; and list_connections keeps a connection's database setting
 * in its row. These are the members rabbitread's module states, the module JSON request language it was modelled on. A
 * language that needs more stays a module until its engine's wave.
 *
 * Each text is written as declared, as `declared-client.ts` writes the agent text: the values each text takes are the
 * SDK's `AGENT_MCP_TEXT_FILLS`, which the types below read, so a text the SDK fills and this module does not hand a
 * value for does not compile: engines, the served engines' names, and limits, the shared result limits, in the
 * description; shown, the number of rows a cut result returned, in the way past it. What a refused request never
 * reached is the language's `copy.reached`, the very text its client facet says it in.
 *
 * Client-safe as `declared-client.ts` is: it imports zod, the SDK's types only, `declared-client.ts` and types.
 */
import type {
  AGENT_MCP_TEXT_FILLS,
  AgentMcpText,
  AgentText,
  StatementLanguageAgent,
} from "@libredb/provider-sdk/manifest";
import { z } from "zod";
import { type DeclaredAgentLanguage, fillAgentText, filledText } from "./declared-client";
import type { AgentDeclaredMcpTool, AgentLanguageMcpComposedFacet } from "./mcp";

/** The texts of an MCP statement tool, by name, with the names of the values Studio fills into each. */
type AgentMcpTextFills = typeof AGENT_MCP_TEXT_FILLS;

/** The values MCP text `Name` is filled with: exactly the names the SDK lists for it, each a string. */
type AgentMcpTextFillValues<Name extends keyof AgentMcpTextFills> = {
  readonly [Fill in AgentMcpTextFills[Name] extends readonly (infer Each extends string)[] ? Each : never]: string;
};

/** The statement a declared tool takes: one non-empty string, as rabbitread's tool takes its own. */
const DECLARED_STATEMENT_INPUT = z.string().min(1, "statement cannot be empty");

/** MCP text `name` of `text`, filled with `values`, the values the SDK lists for that text. */
function mcpText<Name extends keyof AgentMcpTextFills>(
  text: AgentMcpText,
  name: Name,
  values: AgentMcpTextFillValues<Name>,
): string {
  const texts = text as unknown as Readonly<Record<Name, AgentText>>;
  return fillAgentText(texts[name], values);
}

/**
 * The MCP facet of a declared language whose agent part is `agent`, frozen, or null where the part states no MCP
 * statement tool. The tool's name is branded as a declared tool here, and nowhere else.
 */
export function composeDeclaredMcpFacet(
  agent: NonNullable<StatementLanguageAgent>,
): AgentLanguageMcpComposedFacet | null {
  const { mcp } = agent;
  if (mcp === null) return null;
  const { text } = mcp;
  return Object.freeze({
    tool: mcp.tool as AgentDeclaredMcpTool,
    title: mcpText(text, "title", {}),
    statementInput: DECLARED_STATEMENT_INPUT,
    takesDatabase: false,
    strictInput: true,
    paging: "none",
    fence: "language-admission",
    holdsNoTables: mcp.holdsNoTables,
    describe: ({ engines, limits }) => mcpText(text, "description", { engines, limits }),
    words: Object.freeze({
      fewerFields: mcpText(text, "fewerFields", {}),
      // A declared way past a cut result is one sentence for a row cut and a byte cut alike, for any statement.
      readPast: (shown: number) => mcpText(text, "readPast", { shown: String(shown) }),
      rowOverCap: mcpText(text, "rowOverCap", {}),
      reached: filledText(agent.text, "copy", "reached", {}),
    }),
  } satisfies AgentLanguageMcpComposedFacet);
}

/**
 * Each of `languages`' MCP facets by language, in their order: the composed facet, or null where its data states no MCP
 * statement tool. Read by `agentLanguageMcpFacets` in `mcp.ts`, once per installed catalog, on the declared languages
 * that catalog serves.
 *
 * @throws {Error} Naming the tool, where a declared tool is one of `moduleTools`, the module languages' tools this
 * build holds, or where two declared languages state one tool. Each is a host defect, never a precedence.
 */
export function declaredMcpFacets(
  languages: readonly DeclaredAgentLanguage[],
  moduleTools: readonly string[],
): Readonly<Record<string, AgentLanguageMcpComposedFacet | null>> {
  const facets: Record<string, AgentLanguageMcpComposedFacet | null> = {};
  const declaredTools: string[] = [];
  for (const { id, agent } of languages) {
    const facet = composeDeclaredMcpFacet(agent);
    if (facet !== null) {
      const named = JSON.stringify(facet.tool);
      if (moduleTools.includes(facet.tool)) {
        throw new Error(
          `The MCP statement tool ${named} is declared as data and is also a module language's tool of this build.`,
        );
      }
      if (declaredTools.includes(facet.tool)) {
        throw new Error(`The MCP statement tool ${named} is declared as data twice.`);
      }
      declaredTools.push(facet.tool);
    }
    facets[id] = facet;
  }
  return Object.freeze(facets);
}
