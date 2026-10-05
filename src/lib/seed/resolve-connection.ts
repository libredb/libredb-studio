import type { DatabaseConnection } from "@/lib/types";
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered } from "./index";
import { resolveVaultCredentials } from "./credential-resolver";
import { logger } from "@/lib/logger";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { CUSTOM_CONNECTIONS_DISABLED_MESSAGE, customConnectionsAllowed } from "@/lib/config/custom-connections";

export class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    /** A response code of this refusal's own; without one, createErrorResponse derives it from the status. */
    public code?: ApiErrorCode,
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
    /*
     * A CONNECTION THE CALLER SUPPLIED, WHICH THE OPERATOR MAY FORBID (ALLOW_CUSTOM_CONNECTIONS).
     *
     * This branch is the one place an inline connection becomes a provider's input: every route
     * under src/app/api/db reaches its provider through this function, directly or through
     * `handleObjectRequest`, and so does the admin fleet health check. Refusing here, before the
     * record is handed back, is what makes the switch a server rule rather than a hidden button:
     * a Studio that shares an overlay network with other services would otherwise let any
     * signed-in account open a connection to any host that network reaches.
     *
     * Only the caller's own connections are refused. A `seed:` id, arriving as `connectionId` or
     * as the id of an inline record, is resolved from the operator's file below and is untouched
     * by the switch. That is what keeps an unmanaged seed's editable copy working: it keeps its
     * `seed:<id>` id, and the server never used the copy's fields in the first place.
     */
    if (!customConnectionsAllowed()) {
      logger.warn("Custom connection refused", {
        route: "seed/resolve-connection",
        user: session.username,
        role: session.role,
      });
      throw new SeedConnectionError(CUSTOM_CONNECTIONS_DISABLED_MESSAGE, 403, ApiErrorCode.CUSTOM_CONNECTIONS_DISABLED);
    }
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

    // A literal connection carries text as it was written: a discovered connection (CapRover auto-connect spec 9.5)
    // the text another app on the platform network set, and, with SEED_LITERAL_VALUES on, a seed-file connection the
    // text of a file a platform wrote. A `${vault:...}` in it is that text and never a reference to Studio's Vault: it
    // is returned unresolved, and the VaultError that would quote the value is never built. The marker is set in code
    // after the role filter, by the discovery source or by SEED_LITERAL_VALUES, and never read from a file, so with
    // the mode off a seed-file connection, even one whose id starts with caprover-, is resolved below as before.
    if (seedConn.literal) return seedConn;

    // After the access decision, never before it: a `${vault:...}` reference is read here,
    // for this one connection. The list path handed it back unresolved, so listing
    // connections never reads a secret.
    return resolveVaultCredentials(seedConn);
  }

  throw new SeedConnectionError("Either connection or connectionId is required", 400);
}
