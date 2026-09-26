/**
 * The MCP channel for one test (#246): enabled, the harness's URL as the canonical address, and a
 * label written in words, each replaceable and each removable with null, plus tokens minted at run
 * time with the test JWT_SECRET, never committed ones.
 */
import { MCP_ENABLED_ENV, MCP_TOKEN_LABEL_ENV, MCP_TOKEN_TTL_DAYS_ENV, MCP_URL_ENV } from "@/lib/mcp/config";
import { mintMcpToken } from "@/lib/mcp/token";
import { MCP_TEST_URL } from "./mcp-harness";

export const TEST_CHANNEL_LABEL = "test-channel-label";

export interface ChannelOverrides {
  readonly url?: string | null;
  readonly label?: string | null;
  readonly enabled?: string | null;
  readonly ttlDays?: string | null;
}

export function useMcpChannel(overrides: ChannelOverrides = {}): () => void {
  const values: Array<[string, string | null]> = [
    [MCP_ENABLED_ENV, overrides.enabled === undefined ? "true" : overrides.enabled],
    [MCP_URL_ENV, overrides.url === undefined ? MCP_TEST_URL : overrides.url],
    [MCP_TOKEN_LABEL_ENV, overrides.label === undefined ? TEST_CHANNEL_LABEL : overrides.label],
    [MCP_TOKEN_TTL_DAYS_ENV, overrides.ttlDays === undefined ? null : overrides.ttlDays],
  ];
  const saved = values.map(([name]) => [name, process.env[name]] as const);
  for (const [name, value] of values) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export async function mintTestToken(
  owner: { username: string; role: "admin" | "user" } = { username: "alice", role: "admin" },
  clock?: () => number,
): Promise<string> {
  return (await mintMcpToken(owner, clock)).token;
}
