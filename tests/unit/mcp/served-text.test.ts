/**
 * What MCP itself serves names no agent feature (#2252, part 1).
 *
 * Studio's agent mode and MCP share one read-only core, and an MCP client reads MCP's own words, so the server
 * instructions, every listed tool's titles and descriptions, its input and output schema descriptions included, and
 * every string literal of MCP's own sources and statement facets, the refusals MCP writes among them, say what MCP
 * does in MCP's terms. A refusal MCP relays from a provider or a statement language is that code's own sentence and
 * waits for one change that rewords it for both features (`docs/BACKLOG.md` MCP20). Comments are not read: no client
 * sees them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_LANGUAGE_MCP_FACETS } from "@/lib/agent/languages/mcp";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";
import { codeText } from "../../helpers/comment-text";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../helpers/mcp-fixtures";
import { handlerServe, legacyPost, readJsonRpc } from "../../helpers/mcp-harness";
import { registeredMcpToolNames } from "../../helpers/mcp-tool-names";

pinMcpTestEnvironment();

const ROOT = path.resolve(import.meta.dir, "../../..");

/** Agent mode, an agent read or run, the agent read key and the agent credential: the feature, never a protocol's agent. */
const AGENT_FEATURE = /\bagent (?:mode|read|run)\b|\bagent read key\b|\bagent credential\b/i;

/**
 * The same feature in the forms prose also takes, agent-mode, an agent statement or execution among them. It reads only
 * what a client is served, since in source literals a hyphen form is a module path or the agent-read-only profile.
 */
const SERVED_AGENT_FEATURE = /\bagent[- ](?:mode|read|run|statement|execution)\b|\bagent credential\b/i;

/**
 * The served forms a source literal can be held to: every space form, and agent-mode, which no module path or profile
 * spells. The other hyphen forms stay out, since agent-statement is a module path and agent-read the read-only profile.
 */
const LITERAL_AGENT_FEATURE =
  /\bagent (?:mode|read|run|statement|execution)\b|\bagent-mode\b|\bagent read key\b|\bagent credential\b/i;

afterEach(async () => {
  await resetMcpTestState();
});

async function listedTools(): Promise<Array<{ readonly name: string }>> {
  const reply = await readJsonRpc(await handlerServe()(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
  return reply.result?.tools ?? [];
}

/** Every title and description string a listed tool carries, nested ones included, with where it sits. */
function servedTexts(value: unknown, where: string): Array<readonly [string, string]> {
  if (Array.isArray(value)) return value.flatMap((item, index) => servedTexts(item, `${where}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    (key === "title" || key === "description") && typeof inner === "string"
      ? [[`${where}.${key}`, inner] as const]
      : servedTexts(inner, `${where}.${key}`),
  );
}

describe("what a client reads before it calls a tool", () => {
  test("the server instructions name no agent feature", () => {
    expect(MCP_INSTRUCTIONS).not.toMatch(AGENT_FEATURE);
    expect(MCP_INSTRUCTIONS).not.toMatch(SERVED_AGENT_FEATURE);
  });

  test("tools/list answers every registered tool, so the scan reads each one", async () => {
    expect((await listedTools()).map((tool) => tool.name)).toEqual(registeredMcpToolNames());
  });

  test("no listed tool's title, description or schema description names an agent feature", async () => {
    const tools = await listedTools();
    const texts = tools.flatMap((tool) => servedTexts(tool, tool.name));
    for (const tool of tools) expect(texts.map(([where]) => where)).toContain(`${tool.name}.description`);
    expect(texts.filter(([, text]) => AGENT_FEATURE.test(text)).map(([where]) => where)).toEqual([]);
    expect(texts.filter(([, text]) => SERVED_AGENT_FEATURE.test(text)).map(([where]) => where)).toEqual([]);
  });
});

describe("the string literals of MCP's own sources and statement facets", () => {
  const sources = [
    ...new Bun.Glob("src/lib/mcp/**/*.ts").scanSync(ROOT),
    ...new Bun.Glob("src/lib/agent/languages/mcp.ts").scanSync(ROOT),
    ...new Bun.Glob("src/lib/agent/languages/*/mcp.ts").scanSync(ROOT),
  ]
    .map((file) => file.replaceAll("\\", "/"))
    .sort();

  test("the scan reads the MCP context and every declared statement facet", () => {
    expect(sources).toContain("src/lib/mcp/context.ts");
    const declared = Object.entries(AGENT_LANGUAGE_MCP_FACETS)
      .filter(([, facet]) => facet !== null)
      .map(([language]) => `src/lib/agent/languages/${language}/mcp.ts`);
    expect(declared.length).toBeGreaterThan(0);
    for (const file of declared) expect(sources).toContain(file);
  });

  test("no string literal names an agent feature", () => {
    const hits = sources.flatMap((file) =>
      codeText(readFileSync(path.join(ROOT, file), "utf8"), file)
        .strings.filter((piece) => LITERAL_AGENT_FEATURE.test(piece.text))
        .map((piece) => `${file} line ${piece.line + 1}: ${piece.text.match(LITERAL_AGENT_FEATURE)?.[0]}`),
    );
    expect(hits).toEqual([]);
  });
});
