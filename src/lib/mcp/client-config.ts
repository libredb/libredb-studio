/**
 * How each MCP client is pointed at this server (#246), one snippet per client in the keys its own
 * documentation gives: Claude Code, Codex, Cursor, VS Code and Gemini CLI. The settings screen
 * renders these for the deployment's canonical URL, and docs/MCP.md repeats them for an example
 * URL under a guard, so the two cannot drift.
 *
 * The token is read from LIBREDB_MCP_TOKEN wherever the client expands a variable: a name of
 * Studio's own, because Claude Code reads a set of well-known credential variables as empty toward
 * a remote server. VS Code takes it from a password input, and Gemini CLI, whose settings file
 * expands no header variable, shows the literal placeholder.
 */

export const MCP_TOKEN_ENV_NAME = "LIBREDB_MCP_TOKEN";
export const MCP_TOKEN_PLACEHOLDER = "<your-mcp-token>";
export const MCP_VSCODE_INPUT_ID = "libredb-mcp-token";

export type McpClientConfigId = "claude-code-json" | "claude-code-cli" | "codex" | "cursor" | "vscode" | "gemini-cli";

export interface McpClientConfig {
  readonly id: McpClientConfigId;
  readonly client: "Claude Code" | "Codex" | "Cursor" | "VS Code" | "Gemini CLI";
  readonly file: string;
  readonly language: "json" | "toml" | "bash";
  readonly snippet: string;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function mcpClientConfigs(url: string): readonly McpClientConfig[] {
  return [
    {
      id: "claude-code-json",
      client: "Claude Code",
      file: ".mcp.json",
      language: "json",
      snippet: json({
        mcpServers: { libredb: { type: "http", url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV_NAME}}` } } },
      }),
    },
    {
      id: "claude-code-cli",
      client: "Claude Code",
      file: "a shell",
      language: "bash",
      snippet: `claude mcp add --transport http libredb ${url} --header "Authorization: Bearer \${${MCP_TOKEN_ENV_NAME}}"`,
    },
    {
      id: "codex",
      client: "Codex",
      file: "~/.codex/config.toml",
      language: "toml",
      snippet: `[mcp_servers.libredb]\nurl = "${url}"\nbearer_token_env_var = "${MCP_TOKEN_ENV_NAME}"`,
    },
    {
      id: "cursor",
      client: "Cursor",
      file: ".cursor/mcp.json",
      language: "json",
      snippet: json({
        mcpServers: { libredb: { url, headers: { Authorization: `Bearer \${env:${MCP_TOKEN_ENV_NAME}}` } } },
      }),
    },
    {
      id: "vscode",
      client: "VS Code",
      file: ".vscode/mcp.json",
      language: "json",
      snippet: json({
        inputs: [
          { type: "promptString", id: MCP_VSCODE_INPUT_ID, description: "LibreDB Studio MCP token", password: true },
        ],
        servers: {
          libredb: { type: "http", url, headers: { Authorization: `Bearer \${input:${MCP_VSCODE_INPUT_ID}}` } },
        },
      }),
    },
    {
      id: "gemini-cli",
      client: "Gemini CLI",
      file: "~/.gemini/settings.json",
      language: "json",
      snippet: json({
        mcpServers: { libredb: { httpUrl: url, headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` } } },
      }),
    },
  ];
}
