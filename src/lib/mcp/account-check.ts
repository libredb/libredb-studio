import type { AuthInfo } from "@modelcontextprotocol/server";
import { storedAccountAllows } from "@/lib/local-accounts";
import { logger } from "@/lib/logger";
import { MCP_PATH } from "./config";

/**
 * Whether the account behind a verified MCP token still backs it (#784). A token lives for days,
 * so a disabled, demoted, deleted or password-reset account must lose it at the next call, exactly
 * as its session does. Called by the route only: src/proxy.ts is a separately compiled entry that
 * must not load the storage drivers, and stays a signature check.
 *
 * A registry that cannot be read refuses the token rather than trusting it.
 */
export async function mcpTokenOwnerAllowed(authInfo: AuthInfo): Promise<boolean> {
  const { username, role, sessionVersion } = authInfo.extra ?? {};
  if (typeof username !== "string" || (role !== "admin" && role !== "user")) return false;
  try {
    return await storedAccountAllows({
      username,
      role,
      sessionVersion: typeof sessionVersion === "number" ? sessionVersion : undefined,
    });
  } catch (error) {
    logger.error("Could not read the account registry, refusing the MCP token", error, { route: MCP_PATH });
    return false;
  }
}
