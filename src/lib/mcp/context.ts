import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Role } from "@/lib/auth";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { ExecutionProfileError } from "@/lib/db/errors";
import { acquireExecutionProfileProvider, profiledCacheKey, type ExecutionProfile } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { getManagedConnections, seedRolesOf, type ManagedConnection } from "@/lib/seed";
import { resolveVaultCredentials } from "@/lib/seed/credential-resolver";
import { VaultError } from "@/lib/seed/vault-client";
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
 *
 * The listing hands a `${vault:...}` reference back unresolved, as the managed list does, so it is
 * read at acquisition, after the role filter and before the cache key, exactly as resolveConnection
 * reads it for the editor and agent routes; a literal connection is the text it carries and is never
 * resolved. A reference that cannot be read refuses the open, with no fallback.
 */

export interface McpCaller {
  readonly username: string;
  readonly role: Role;
  readonly claimRoles?: readonly string[];
}

export interface McpToolCall {
  readonly context: McpConnectionContext;
  readonly signal: AbortSignal;
}

/** The identity the verifier put on the token, and an explicit error when it is not there. */
export function mcpCaller(authInfo: AuthInfo): McpCaller {
  const username = authInfo.extra?.username;
  const role = authInfo.extra?.role;
  const claimRoles = authInfo.extra?.claimRoles;
  if (typeof username !== "string" || username === "" || (role !== "admin" && role !== "user")) {
    throw new Error("The verified MCP identity carries no username and role");
  }
  return {
    username,
    role,
    ...(Array.isArray(claimRoles) ? { claimRoles: claimRoles as string[] } : {}),
  };
}

const pendingAcquisitions = new Map<string, Promise<DatabaseProvider>>();

/**
 * The connection with its `${vault:...}` references read, or an ExecutionProfileError naming it, so both tools answer
 * the refusal in Studio's words. The VaultError's own text stays in the server log: it may quote the reference.
 */
async function resolvedSecrets(connection: ManagedConnection): Promise<ManagedConnection> {
  if (connection.literal) return connection;
  try {
    return await resolveVaultCredentials(connection);
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    logger.error("Could not read a seed connection's Vault reference for MCP", redactError(error), {
      route: "/api/mcp",
      connectionId: connection.id,
    });
    throw new ExecutionProfileError(
      `Connection "${connection.id}" could not be opened: a secret reference in its seed entry could not be read from Vault, so nothing was sent to the database. The server log names the cause.`,
      "CONNECTION_SECRET_UNRESOLVABLE",
    );
  }
}

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

  async acquire(listed: ManagedConnection, profile: ExecutionProfile): Promise<DatabaseProvider> {
    const connection = await resolvedSecrets(listed);
    // The caller's editor posture on this connection (non-admin DuckDB file access): it decides whether a
    // SQLite handle opens at all and which open single-writer handle an operations acquisition may
    // borrow, and it is part of the key, so it is derived first; every caller that can resolve one seed
    // shares it.
    const requester = editorExecutionContext(this.caller, connection);
    const key = await profiledCacheKey(connection, profile, requester);
    const pending = pendingAcquisitions.get(key);
    if (pending !== undefined) return pending;
    const acquisition = acquireExecutionProfileProvider(connection, profile, {}, requester).finally(() => {
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
      const connections = await getManagedConnections(seedRolesOf(this.caller));
      return connections.filter((connection) => connection.mcp === true);
    } catch (error) {
      logger.error("Could not load managed connections for MCP", redactError(error), { route: "/api/mcp" });
      return MCP_CONNECTIONS_UNREADABLE;
    }
  }
}
