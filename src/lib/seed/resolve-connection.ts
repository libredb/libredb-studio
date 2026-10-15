import type { DatabaseConnection } from "@/lib/types";
import { getSeedConnectionByIdUnfiltered } from "./index";
import { resolveVaultCredentials } from "./credential-resolver";
import { logger } from "@/lib/logger";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { CUSTOM_CONNECTIONS_DISABLED_MESSAGE, customConnectionsAllowed } from "@/lib/config/custom-connections";
import { governanceEnabled } from "@/lib/governance/config";
import {
  GovernanceUnavailableError,
  type Principal,
  type VisibilityOptions,
  visibleConnectionById,
} from "@/lib/governance/visible";

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

/**
 * The one answer under governance for a connection the caller holds no grant on, whatever the reason: no such
 * connection, a grant to someone else, an expired grant or a row Studio did not admit. It names no id, so two misses
 * read the same.
 */
const CONNECTION_NOT_FOUND_MESSAGE = "Connection not found: it does not exist or is not granted to you";

/** Where a governed miss is recorded: a phase of the request, as the MCP audit names its phases, never a URL. */
const GOVERNED_MISS_TARGET = "governance/connection";

/** The dispatcher's answer, with a governance snapshot that cannot be served turned into this module's refusal. */
async function visibleSeedConnection(session: Principal, seedId: string, options?: VisibilityOptions) {
  try {
    return await visibleConnectionById(session, seedId, options);
  } catch (error) {
    if (error instanceof GovernanceUnavailableError) {
      throw new SeedConnectionError(error.message, error.statusCode, error.code);
    }
    throw error;
  }
}

/**
 * The audit line of a governed miss, which is the only record of one: the 404 it answers is the same for every miss.
 *
 * METERED on the `anon` bucket and keyed on the username, as `auditRoleDenial` in src/lib/api/require-session.ts is
 * and for its reason: a signed-in session can probe ids in a loop, and every line would fill a container log volume
 * and push real events out of the ring the admin UI reads. The refusal is unconditional; only its record is bounded.
 * Isolated in its own try/catch, so a broken audit sink never turns the decided 404 into a 500.
 */
function auditGovernedMiss(seedId: string, username: string): void {
  const notice = consumeRateLimit("anon", username);
  if (!notice.allowed && !notice.tripped) return;
  try {
    emitAuditEvent({
      type: "permission_denied",
      action: "denied",
      target: GOVERNED_MISS_TARGET,
      user: username,
      result: "failure",
      reason: "connection_not_granted",
      connectionName: seedId,
    });
  } catch (auditError) {
    logger.error("Failed to record permission_denied audit event", auditError, { route: "seed/resolve-connection" });
  }
}

export async function resolveConnection(
  body: { connection?: DatabaseConnection; connectionId?: string },
  session: Principal,
  /** Which credential a governed connection carries (src/lib/governance/visible.ts); nothing without governance. */
  options?: VisibilityOptions,
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
  // A present id must be a non-empty string: an empty one is falsy but not nullish, so `??` below
  // would keep it and drop the inline record's seed claim, handing the caller's copy back verbatim.
  if (connectionId != null && (typeof connectionId !== "string" || connectionId === "")) {
    throw new SeedConnectionError("Invalid connection ID format", 400);
  }
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
    // `managed` is the operator's grant (BigQuery and Firestore read it to use server credentials).
    return { ...connection, managed: false };
  }

  if (effectiveId) {
    if (!effectiveId.startsWith("seed:")) {
      throw new SeedConnectionError("Invalid connection ID format", 400);
    }

    const seedId = effectiveId.slice(5);
    /*
     * Through the dispatcher the managed list is built by, so a route opens exactly what the list shows. Under
     * governance (docs/GOVERNANCE.md) that is a connection the session's identity provider subject holds an unexpired
     * grant on, with the credential of the grant's level, or the read credential where the caller asks for it; while
     * the snapshot cannot be served, the dispatcher's 503 is answered for every id.
     */
    const seedConn = await visibleSeedConnection(session, seedId, options);

    if (!seedConn) {
      /*
       * UNDER GOVERNANCE, ONE ANSWER FOR EVERY MISS, AND NO LOOKUP TO TELL THEM APART. The 403 below confirms that an
       * id exists for someone, which is exactly what a caller probing a catalog of governed connections must not
       * learn, so an id that does not exist and one granted to another subject answer the same 404, decided from the
       * caller's own grants alone. The audit line is where an operator sees which id was asked for.
       */
      if (governanceEnabled()) {
        auditGovernedMiss(seedId, session.username);
        throw new SeedConnectionError(CONNECTION_NOT_FOUND_MESSAGE, 404, ApiErrorCode.CONNECTION_NOT_FOUND);
      }
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
    // the mode off a seed-file connection, even one whose id starts with caprover-, is resolved below as before. Every
    // governed connection carries it too: its values are the text a control plane set, with credentials Studio opened.
    if (seedConn.literal) return seedConn;

    // After the access decision, never before it: a `${vault:...}` reference is read here,
    // for this one connection. The list path handed it back unresolved, so listing
    // connections never reads a secret.
    return resolveVaultCredentials(seedConn);
  }

  throw new SeedConnectionError("Either connection or connectionId is required", 400);
}
