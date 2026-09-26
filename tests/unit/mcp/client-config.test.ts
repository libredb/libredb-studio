/**
 * The client configuration the settings screen renders and docs/MCP.md repeats (#246), one
 * snippet per client in that client's own documented keys, with the token read from the
 * environment where the client expands a variable and a plain placeholder where it does not.
 */
import { describe, expect, test } from "bun:test";
import {
  MCP_TOKEN_ENV_NAME,
  MCP_TOKEN_PLACEHOLDER,
  MCP_VSCODE_INPUT_ID,
  mcpClientConfigs,
} from "@/lib/mcp/client-config";

const URL = "https://studio.example.com/tools/libredb/api/mcp";
const configs = mcpClientConfigs(URL);
const snippet = (id: string) => configs.find((config) => config.id === id)?.snippet ?? "";

describe("the snippets", () => {
  test("cover five clients in the order the screen shows them", () => {
    expect(configs.map((config) => [config.id, config.client, config.language])).toEqual([
      ["claude-code-json", "Claude Code", "json"],
      ["claude-code-cli", "Claude Code", "bash"],
      ["codex", "Codex", "toml"],
      ["cursor", "Cursor", "json"],
      ["vscode", "VS Code", "json"],
      ["gemini-cli", "Gemini CLI", "json"],
    ]);
  });

  test("Claude Code takes type http, the URL and a bearer header from LIBREDB_MCP_TOKEN", () => {
    expect(JSON.parse(snippet("claude-code-json"))).toEqual({
      mcpServers: { libredb: { type: "http", url: URL, headers: { Authorization: "Bearer ${LIBREDB_MCP_TOKEN}" } } },
    });
    expect(snippet("claude-code-cli")).toBe(
      `claude mcp add --transport http libredb ${URL} --header "Authorization: Bearer \${LIBREDB_MCP_TOKEN}"`,
    );
  });

  test("Codex takes url and bearer_token_env_var", () => {
    expect(snippet("codex")).toBe(`[mcp_servers.libredb]\nurl = "${URL}"\nbearer_token_env_var = "LIBREDB_MCP_TOKEN"`);
  });

  test("Cursor takes url and a header expanded from ${env:LIBREDB_MCP_TOKEN}", () => {
    expect(JSON.parse(snippet("cursor"))).toEqual({
      mcpServers: { libredb: { url: URL, headers: { Authorization: "Bearer ${env:LIBREDB_MCP_TOKEN}" } } },
    });
  });

  test("VS Code takes type http and a password input the header names", () => {
    expect(JSON.parse(snippet("vscode"))).toEqual({
      inputs: [
        { type: "promptString", id: "libredb-mcp-token", description: "LibreDB Studio MCP token", password: true },
      ],
      servers: { libredb: { type: "http", url: URL, headers: { Authorization: "Bearer ${input:libredb-mcp-token}" } } },
    });
  });

  test("Gemini CLI takes httpUrl, never url, and the literal placeholder", () => {
    const parsed = JSON.parse(snippet("gemini-cli"));
    expect(parsed).toEqual({
      mcpServers: { libredb: { httpUrl: URL, headers: { Authorization: "Bearer <your-mcp-token>" } } },
    });
    expect(parsed.mcpServers.libredb).not.toHaveProperty("url");
  });

  test("no snippet carries a token in a URL or anything shaped like a JWT", () => {
    for (const config of configs) {
      expect(config.snippet).not.toMatch(/[?&](?:token|access_token)=/);
      expect(config.snippet).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });

  test("the names the snippets share", () => {
    expect([MCP_TOKEN_ENV_NAME, MCP_TOKEN_PLACEHOLDER, MCP_VSCODE_INPUT_ID]).toEqual([
      "LIBREDB_MCP_TOKEN",
      "<your-mcp-token>",
      "libredb-mcp-token",
    ]);
  });
});
