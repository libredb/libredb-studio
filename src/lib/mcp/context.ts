import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Role } from "@/lib/auth";
import { acquireExecutionProfileProvider, profiledCacheKey, type ExecutionProfile } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { getManagedConnections, type ManagedConnection } from "@/lib/seed";
import { redactError } from "./serializer";

/** The answer of a context whose seed file could not be loaded; the cause is logged, never sent. */
export const MCP_CONNECTIONS_UNREADABLE = "unreadable";
export const MCP_CONNECTIONS_UNREADABLE_TEXT =
  "The connection configuration could not be read, so no connection is available. The server log names the cause.";

/**
 * The MCP tools' view of the connections one caller may use (#246).
 *
 * One instance per request, built by the SDK server factory around the verified identity. The
 * seed file is read lazily by the first tool that needs it, so initialize, server/discover and
 * tools/list never depend on it, and within one request it is read once.
 *
 * Acquisition goes through acquireExecutionProfileProvider and nothing else. Concurrent first
 * acquisitions of one connection and profile are joined here, keyed on the factory's own
 * profiledCacheKey, because a second derivation of that key would reopen the divergence
 * GHSA-3wh2-8x78-jfw4 closed (src/lib/db/provider-cache-key.ts). After the key is awaited, the
 * lookup and the insertion happen in one synchronous step, and a settled acquisition leaves the
 * map, so a failed one is retried by the next caller.
 *
 * A seed file that cannot be loaded answers MCP_CONNECTIONS_UNREADABLE, which every tool turns
 * into its own explicit error.
 */

export interface McpCaller {
  readonly username: string;
  readonly role: Role;
}

export interface McpToolCall {
  readonly context: McpConnectionContext;
  readonly signal: AbortSignal;
}

/** The identity the verifier put on the token, and an explicit error when it is not there. */
export function mcpCaller(authInfo: AuthInfo): McpCaller {
  const username = authInfo.extra?.username;
  const role = authInfo.extra?.role;
  if (typeof username !== "string" || username === "" || (role !== "admin" && role !== "user")) {
    throw new Error("The verified MCP identity carries no username and role");
  }
  return { username, role };
}

const pendingAcquisitions = new Map<string, Promise<DatabaseProvider>>();

export class McpConnectionContext {
  private visible: Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> | null = null;

  constructor(readonly caller: McpCaller) {}

  visibleConnections(): Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> {
    this.visible ??= this.load();
    return this.visible;
  }

  async resolve(connectionId: string): Promise<ManagedConnection | null | typeof MCP_CONNECTIONS_UNREADABLE> {
    const visible = await this.visibleConnections();
    if (visible === MCP_CONNECTIONS_UNREADABLE) return visible;
    return visible.find((connection) => connection.id === connectionId) ?? null;
  }

  async acquire(connection: ManagedConnection, profile: ExecutionProfile): Promise<DatabaseProvider> {
    const key = await profiledCacheKey(connection, profile);
    const pending = pendingAcquisitions.get(key);
    if (pending !== undefined) return pending;
    const acquisition = acquireExecutionProfileProvider(connection, profile).finally(() => {
      pendingAcquisitions.delete(key);
    });
    pendingAcquisitions.set(key, acquisition);
    return acquisition;
  }

  /**
   * Only what the operator opted in: a seed entry without mcp: true, and every built-in sample,
   * is not visible. A file that cannot be loaded is an answer of its own, never an empty list,
   * because an empty list would tell the client there is nothing to reach when the truth is that
   * the server could not tell.
   */
  private async load(): Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> {
    try {
      const connections = await getManagedConnections([this.caller.role]);
      return connections.filter((connection) => connection.mcp === true);
    } catch (error) {
      logger.error("Could not load managed connections for MCP", redactError(error), { route: "/api/mcp" });
      return MCP_CONNECTIONS_UNREADABLE;
    }
  }
}
