import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { configuredOriginHostnames } from "@/lib/api/origin-check";
import { readMcpUrl } from "./config";

/**
 * The MCP endpoint's Origin and Host gate (#246), one function the proxy and the route both call,
 * so the two layers cannot answer one request differently.
 *
 * Origin runs on every method, GET included, which checkOrigin exempts, because the transport's
 * Origin rule binds every connection. Host runs only on a loopback bind, where DNS rebinding is
 * what reaches a local server; containers resolve HOSTNAME to "::" or 0.0.0.0 and rely on the
 * Origin check and the token. The allowlists are the localhost names, the canonical URL's host
 * and the ALLOWED_ORIGINS hosts, never the request's Host or X-Forwarded-Host, which under
 * rebinding carry the attacker's name. The SDK's validators ignore ports, refuse a present but
 * unparseable Origin, and refuse a missing Host.
 */

export const MCP_LOOPBACK_BINDS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export type McpOriginHostReason = "origin_mismatch" | "mcp_host_not_allowed";

export interface McpOriginHostRefusal {
  readonly response: Response;
  readonly reason: McpOriginHostReason;
}

export function isLoopbackBind(): boolean {
  return MCP_LOOPBACK_BINDS.has((process.env.HOSTNAME ?? "").trim().toLowerCase());
}

/**
 * The canonical URL's host when LIBREDB_MCP_URL is valid. An invalid URL adds nothing here: the
 * bearer gate refuses the request for it as an unconfigured channel.
 */
function canonicalHostnames(): string[] {
  const url = readMcpUrl();
  return url.ok ? [new URL(url.value).hostname] : [];
}

export function mcpOriginAllowlist(): string[] {
  return [...localhostAllowedOrigins(), ...canonicalHostnames(), ...configuredOriginHostnames()];
}

export function mcpHostAllowlist(): string[] {
  return [...localhostAllowedHostnames(), ...canonicalHostnames(), ...configuredOriginHostnames()];
}

export function mcpOriginHostRefusal(request: Request): McpOriginHostRefusal | null {
  const origin = originValidationResponse(request, mcpOriginAllowlist());
  if (origin !== undefined) return { response: origin, reason: "origin_mismatch" };
  if (!isLoopbackBind()) return null;
  const host = hostHeaderValidationResponse(request, mcpHostAllowlist());
  return host === undefined ? null : { response: host, reason: "mcp_host_not_allowed" };
}
