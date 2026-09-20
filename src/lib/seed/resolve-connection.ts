import type { DatabaseConnection } from "@/lib/types";
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered } from "./index";
import { resolveVaultCredentials } from "./credential-resolver";
import { logger } from "@/lib/logger";

export class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}

export async function resolveConnection(
  body: { connection?: DatabaseConnection; connectionId?: string },
  session: { role: string; username: string },
): Promise<DatabaseConnection> {
  const { connection, connectionId } = body;

  /*
   * THE `seed:` NAMESPACE IS THE OPERATOR'S, AND A CALLER MAY NOT CLAIM INTO IT
   * (GHSA-3wh2-8x78-jfw4 root cause 2).
   *
   * An inline `connection` used to be returned verbatim, id included, while the role filter
   * below guarded only the `connectionId` path. So the same managed connection was reachable
   * two ways and only one of them was checked: a `user` account posting a connection object
   * that CLAIMED `seed:admin-only` skipped the filter entirely. It is one namespace with one
   * gate now - a claimed seed id is resolved from the operator's config, exactly as if it had
   * arrived as `connectionId`, and the caller's own copy of the record is discarded.
   *
   * An id outside the namespace is a user's own saved connection and stays untouched: those
   * carry the caller's own credentials and are not what the role filter is about.
   */
  const claimedSeedId = connection?.id?.startsWith("seed:") ? connection.id : undefined;
  const effectiveId = connectionId ?? claimedSeedId;

  if (connection && !effectiveId) {
    return connection;
  }

  if (effectiveId) {
    if (!effectiveId.startsWith("seed:")) {
      throw new SeedConnectionError("Invalid connection ID format", 400);
    }

    const seedId = effectiveId.slice(5);
    const seedConn = await getSeedConnectionById(seedId, [session.role]);

    if (!seedConn) {
      const exists = await getSeedConnectionByIdUnfiltered(seedId);
      if (exists) {
        logger.warn("Seed connection access denied", {
          route: "seed/resolve-connection",
          connectionId: seedId,
          user: session.username,
          role: session.role,
        });
        throw new SeedConnectionError(
          `Access denied: connection "${seedId}" not available for role "${session.role}"`,
          403,
        );
      }
      throw new SeedConnectionError(`Seed connection "${seedId}" not found`, 404);
    }

    logger.debug("Resolved seed connection", {
      route: "seed/resolve-connection",
      connectionId: seedId,
      user: session.username,
    });

    // After the access decision, never before it: a `${vault:...}` reference is read here,
    // for this one connection. The list path handed it back unresolved, so listing
    // connections never reads a secret.
    return resolveVaultCredentials(seedConn);
  }

  throw new SeedConnectionError("Either connection or connectionId is required", 400);
}
