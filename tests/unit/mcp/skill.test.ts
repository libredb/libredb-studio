/**
 * The libredb-studio skill and the Claude Code plugin that ships it (#2252, part 5), held to the code they describe.
 *
 * The skill follows the Agent Skills format (https://agentskills.io/specification): its frontmatter carries the
 * standard fields alone, and its name is its directory's. It names the metadata tools and no statement tool, every
 * identifier it puts in code is a tool name or schema key tools/list serves or one of three fixed names (the method,
 * the error code and the seed key), and every bound and answer it quotes is read here from the code, so it cannot
 * drift as statement tools, engines or answers change. It describes MCP in the same words as docs/MCP.md: the word
 * agent only where it says these tools are not Studio's in-app agent.
 *
 * The plugin's server entry is the settings screen's Claude Code snippet with the plugin's own two values in place of
 * the address and the token, the token is a required, sensitive option that no file of the repository holds, and no
 * manifest carries a version, which would hold every user on one copy of the skill. Neither Claude Code nor an Agent
 * Skills validator runs in CI, so this file is the guard; the validators' output is in the pull request.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { getDBConfig } from "@/lib/db-ui-config";
import { MCP_TOKEN_ENV_NAME, mcpClientConfigs } from "@/lib/mcp/client-config";
import { MCP_CONNECTIONS_UNREADABLE_TEXT } from "@/lib/mcp/context";
import { MCP_ENGINE_ERROR_PREFIX, MCP_RESULT_CAP_BYTES } from "@/lib/mcp/output";
import { fenceRefusalText, profileRefusalText } from "@/lib/mcp/tools/read-query-limits";
import { MCP_STATEMENT_TOOLS } from "@/lib/mcp/tools/statement-arms";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { handlerServe, legacyPost, readJsonRpc } from "../../helpers/mcp-harness";
import { servedEngineSeeds } from "../../helpers/mcp-served-seeds";
import { registeredMcpToolNames } from "../../helpers/mcp-tool-names";
import { namedLabels } from "../../helpers/repo-text-scope";

pinMcpTestEnvironment();

const ROOT = path.resolve(import.meta.dir, "../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const json = (relative: string): Record<string, unknown> => JSON.parse(read(relative)) as Record<string, unknown>;

const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const PLUGIN_DIR = "plugins/libredb-studio";
const PLUGIN_FILE = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
const SKILL_DIR = `${PLUGIN_DIR}/skills/libredb-studio`;
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
const GUIDE_URL = "https://github.com/libredb/libredb-studio/blob/main/docs/MCP.md";

/** The frontmatter fields the Agent Skills format defines; a skill carries no other. */
const STANDARD_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
/** Code the skill may hold that is no tool name and no schema key: the method, the error code and the seed key. */
const NAMED_IN_CODE = ["tools/list", "-32603", "mcp: true"];
const LABELS = SHIPPED_DATABASE_TYPES.map((type) => getDBConfig(type).label);

const SKILL = read(SKILL_FILE);
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
const META = (FRONTMATTER === null ? {} : parseYaml(FRONTMATTER[1])) as Record<string, unknown>;
const BODY = FRONTMATTER === null ? SKILL : SKILL.slice(FRONTMATTER[0].length);

interface TextLine {
  readonly line: number;
  readonly text: string;
}

/** The lines outside fenced blocks, numbered from one. */
function proseLines(text: string): TextLine[] {
  const prose: TextLine[] = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced) prose.push({ line: index + 1, text: line });
  });
  return prose;
}

/** A line's words alone: inline code and link destinations removed. */
const words = (text: string): string => text.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]");

/** The inline code spans outside fenced blocks. */
const codeSpans = (text: string): string[] =>
  proseLines(text).flatMap((piece) => [...piece.text.matchAll(/`([^`]+)`/g)].map((match) => match[1]));

/** Every property name of a JSON Schema, nested objects, array items and unions included, added to `names`. */
function propertyNames(schema: unknown, names: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, names);
  } else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value !== null && typeof value === "object") names.push(...Object.keys(value));
      propertyNames(value, names);
    }
  }
  return names;
}

/** Every key, at any depth, of a parsed JSON value, added to `keys`. */
function keysOf(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.push(key);
      keysOf(inner, keys);
    }
  }
  return keys;
}

/** Every file under a directory, relative to it, sorted. */
function filesUnder(relative: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(path.join(ROOT, dir)).flatMap((name) => {
      const child = path.posix.join(dir, name);
      return statSync(path.join(ROOT, child)).isDirectory() ? walk(child) : [child];
    });
  return walk(relative)
    .map((file) => path.posix.relative(relative, file))
    .sort();
}

const seedDir = mkdtempSync(path.join(tmpdir(), "libredb-mcp-skill-"));

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(seedDir, { recursive: true, force: true });
});

interface ListedTool {
  readonly name: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

/**
 * What a token that reaches every served engine lists, every registered tool among it. GOVERNANCE_SOURCE is cleared
 * while it lists, so a developer's environment never decides which connections are available.
 */
async function listedTools(): Promise<readonly ListedTool[]> {
  const governance = process.env.GOVERNANCE_SOURCE;
  delete process.env.GOVERNANCE_SOURCE;
  try {
    writeSeedFile(seedDir, servedEngineSeeds(seedDir));
    const reply = await readJsonRpc(await handlerServe()(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
    return reply.result?.tools ?? [];
  } finally {
    if (governance === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = governance;
  }
}

describe("the skill's frontmatter", () => {
  test("is the standard fields alone: name, description, license and compatibility", () => {
    expect(FRONTMATTER).not.toBeNull();
    for (const field of Object.keys(META)) expect(STANDARD_FIELDS).toContain(field);
    expect(Object.keys(META).sort()).toEqual(["compatibility", "description", "license", "name"]);
  });

  test("names the skill as its directory, in lowercase words joined by single hyphens, within 64 characters", () => {
    const name = String(META.name);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(path.basename(SKILL_DIR));
  });

  test("describes what the skill does and when to use it in 1 to 1,024 characters, naming no engine", () => {
    const description = String(META.description);
    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("bounded, read-only statements");
    expect(description).toMatch(/\buse it when\b/i);
    expect(namedLabels(description, LABELS)).toEqual([]);
  });

  test("states what it needs in 1 to 500 characters", () => {
    const compatibility = String(META.compatibility);
    expect(compatibility.length).toBeGreaterThanOrEqual(1);
    expect(compatibility.length).toBeLessThanOrEqual(500);
    expect(compatibility).toContain("/api/mcp");
  });

  test("takes the repository's license", () => {
    expect(META.license).toBe(json("package.json").license);
  });
});

describe("the skill's text", () => {
  test("stays under 200 lines, one sentence on each line outside fenced blocks", () => {
    expect(SKILL.replace(/\n$/, "").split("\n").length).toBeLessThan(200);
    const twoSentences = proseLines(SKILL)
      .filter((piece) => /[.!?]["')\]]*\s+\S/.test(words(piece.text).replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")))
      .map((piece) => `${piece.line}: ${piece.text}`);
    expect(twoSentences).toEqual([]);
  });

  test("names every metadata tool and no statement tool", () => {
    const metadataTools = registeredMcpToolNames().filter(
      (name) => !(MCP_STATEMENT_TOOLS as readonly string[]).includes(name),
    );
    expect(metadataTools.length).toBeGreaterThan(0);
    for (const tool of metadataTools) expect(SKILL).toContain(`\`${tool}\``);
    expect(MCP_STATEMENT_TOOLS.filter((tool) => SKILL.includes(tool))).toEqual([]);
  });

  test("puts in code only a tool name, a key of a listed tool's input or output schema, or one of three fixed names", async () => {
    const tools = await listedTools();
    expect(tools.map((tool) => tool.name)).toEqual(registeredMcpToolNames());
    const known = new Set(NAMED_IN_CODE);
    for (const tool of tools) {
      known.add(tool.name);
      for (const name of propertyNames([tool.inputSchema, tool.outputSchema])) known.add(name);
    }
    const spans = codeSpans(BODY);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.filter((span) => !known.has(span))).toEqual([]);
    for (const fixed of NAMED_IN_CODE) expect(spans).toContain(fixed);
  });

  test("names no engine, so it holds for every engine a tool serves", () => {
    expect(namedLabels(SKILL, LABELS)).toEqual([]);
  });

  test("uses the word agent only to say these tools are not Studio's in-app agent, and never says read-only SQL", () => {
    const stray = proseLines(SKILL)
      .filter((piece) => /\bagents?\b/i.test(words(piece.text).replace(/Studio's in-app agent/g, "")))
      .map((piece) => `${piece.line}: ${piece.text}`);
    expect(stray).toEqual([]);
    expect(SKILL).toContain("Studio's in-app agent");
    expect(SKILL).not.toMatch(/\bread-only SQL\b/i);
  });

  test("states the result limit the server enforces", () => {
    const [, kibibytes] = /\b(\d+) KiB\b/.exec(BODY) ?? [];
    expect(Number(kibibytes) * 1024).toBe(MCP_RESULT_CAP_BYTES);
  });

  test("quotes the server's own words for a refusal, an engine error and an unreadable seed file", () => {
    expect(fenceRefusalText("code", "postgres")).toContain("was refused before it reached the database");
    expect(BODY).toContain("was refused before it reached the database");
    expect(profileRefusalText("message", "engines", "tool")).toContain("tool cannot run on this connection:");
    expect(BODY).toContain("cannot run on this connection");
    expect(BODY).toContain(`"${MCP_ENGINE_ERROR_PREFIX.trimEnd()}"`);
    expect(MCP_CONNECTIONS_UNREADABLE_TEXT).toContain("The connection configuration could not be read");
    expect(BODY).toContain("the connection configuration could not be read");
  });

  test("names only HTTP statuses that docs/MCP.md's Troubleshooting table explains", () => {
    const guide = read("docs/MCP.md");
    const statuses = [...new Set([...BODY.matchAll(/\b([45]\d\d)\b/g)].map((match) => match[1]))];
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) expect(guide).toContain(`\n| ${status} |`);
    expect(guide).toContain("\n| 200 `-32603` |");
  });

  test("lays a 401 on the token or the configured address, and a 404 on MCP being off or the address not reaching Studio", () => {
    const line = (status: string): string =>
      BODY.split("\n").find((text) => text.startsWith(`A ${status} means `)) ?? "";
    expect(line("401")).toBe(
      "A 401 means the token is missing, expired, revoked or minted for another Studio address, or the configured address is not exactly Studio's MCP address, which ends in /api/mcp, so check the address before the user mints a new token on Studio's MCP settings screen and saves it in this client's configuration.",
    );
    expect(line("404")).toBe(
      "A 404 means MCP is off on that Studio, or the configured address does not reach Studio at all.",
    );
  });

  test("links Studio's MCP guide, which is the plugin's homepage", () => {
    expect(SKILL).toContain(`](${GUIDE_URL})`);
    expect(json(PLUGIN_FILE).homepage).toBe(GUIDE_URL);
    expect(existsSync(path.join(ROOT, new URL(GUIDE_URL).pathname.split("/blob/main/")[1] ?? ""))).toBe(true);
  });
});

describe("the plugin", () => {
  const plugin = json(PLUGIN_FILE);
  const userConfig = plugin.userConfig as Record<string, Record<string, unknown>>;

  test("holds its manifest and the skill, and nothing else: no .mcp.json, script or reference file", () => {
    expect(filesUnder(PLUGIN_DIR)).toEqual([".claude-plugin/plugin.json", "skills/libredb-studio/SKILL.md"]);
  });

  test("declares no hook, server process, monitor, command or agent, which would run code or get the token in its environment", () => {
    expect(Object.keys(plugin).sort()).toEqual([
      "author",
      "description",
      "displayName",
      "homepage",
      "license",
      "mcpServers",
      "name",
      "repository",
      "userConfig",
    ]);
  });

  test("is named as its directory and its skill, with the repository's license and address", () => {
    expect(plugin.name).toBe(path.basename(PLUGIN_DIR));
    expect(plugin.name).toBe(META.name);
    expect(plugin.license).toBe(json("package.json").license);
    expect(plugin.repository).toBe((json("package.json").repository as { url: string }).url);
  });

  test("serves the settings screen's Claude Code entry, with its own address and token in place of the snippet's", () => {
    const snippet = mcpClientConfigs("${user_config.mcp_url}").find((config) => config.id === "claude-code-json");
    expect(snippet).toBeDefined();
    const expected = JSON.parse(
      (snippet?.snippet ?? "").replace(`\${${MCP_TOKEN_ENV_NAME}}`, "${user_config.mcp_token}"),
    ) as { mcpServers: unknown };
    expect(plugin.mcpServers).toEqual(expected.mcpServers);
  });

  test("declares every option it references, and references every option it declares", () => {
    const referenced = [...read(PLUGIN_FILE).matchAll(/\$\{user_config\.([A-Za-z_]\w*)\}/g)].map((match) => match[1]);
    expect([...new Set(referenced)].sort()).toEqual(Object.keys(userConfig).sort());
  });

  test("asks for the address and the token, the token required and sensitive, so only the address reaches settings.json", () => {
    expect(userConfig.mcp_url).toMatchObject({ type: "string", required: true });
    expect(userConfig.mcp_url.sensitive).toBeUndefined();
    expect(userConfig.mcp_token).toMatchObject({ type: "string", required: true, sensitive: true });
    for (const option of Object.values(userConfig)) {
      expect(typeof option.title).toBe("string");
      expect(typeof option.description).toBe("string");
    }
  });

  test("holds no credential in a header: each value is a scheme and an option reference", () => {
    const servers = Object.values(plugin.mcpServers as Record<string, { headers?: Record<string, string> }>);
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      for (const value of Object.values(server.headers ?? {})) {
        expect(value.replace(/\$\{user_config\.\w+\}/g, "")).toMatch(/^(?:Bearer )?$/);
      }
    }
  });

  test("says what it does in Studio's words, never read-only SQL", () => {
    expect(String(plugin.description)).toContain("bounded, read-only statements");
    expect(String(plugin.description)).not.toMatch(/\bread-only SQL\b/i);
  });
});

describe("the marketplace", () => {
  const marketplace = json(MARKETPLACE_FILE);
  const entries = marketplace.plugins as Array<Record<string, unknown>>;

  test("is the only file under .claude-plugin at the repository root", () => {
    expect(filesUnder(".claude-plugin")).toEqual(["marketplace.json"]);
  });

  test("is named libredb and lists the plugin by the name its manifest and directory carry", () => {
    expect(marketplace.name).toBe("libredb");
    expect(entries.map((entry) => entry.name)).toEqual([json(PLUGIN_FILE).name]);
  });

  test("points at the plugin by a ./ path inside the repository, with no .. in it", () => {
    for (const entry of entries) {
      const source = String(entry.source);
      expect(source.startsWith("./")).toBe(true);
      expect(source.split("/")).not.toContain("..");
      expect(path.posix.normalize(source)).toBe(PLUGIN_DIR);
      expect(existsSync(path.join(ROOT, source, ".claude-plugin", "plugin.json"))).toBe(true);
    }
  });

  test("says what the plugin does in Studio's words, never read-only SQL", () => {
    for (const text of [marketplace.description, ...entries.map((entry) => entry.description)]) {
      expect(String(text)).not.toMatch(/\bread-only SQL\b/i);
    }
    expect(String(entries[0]?.description)).toContain("bounded, read-only statements");
  });

  test("carries no version, and neither does the plugin, so every install follows the repository", () => {
    expect(keysOf(marketplace)).not.toContain("version");
    expect(keysOf(json(PLUGIN_FILE))).not.toContain("version");
  });
});
