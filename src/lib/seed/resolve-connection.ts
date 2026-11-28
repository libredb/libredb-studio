import type { DatabaseConnection } from "@/lib/types";
import { getSeedConnectionByIdUnfiltered } from "./index";
import { resolveVaultCredentials } from "./credential-resolver";
import { logger } from "@/lib/logger";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { SEED_ONLY_FIELD_NAMES } from "@/lib/db/connection-fields";
import { type EngineConnection, type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { CUSTOM_CONNECTIONS_DISABLED_MESSAGE, customConnectionsAllowed } from "@/lib/config/custom-connections";
import { governanceEnabled } from "@/lib/governance/config";
import { accessReviewEnabled } from "@/lib/kubernetes-access/config";
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
 * connection, a grant to someone else, an expired grant or a row Studio did not admit. With the Kubernetes access review
 * on it is the one answer for every miss as well: no such connection, one the review keeps from the caller, one whose
 * review failed, or a seed the caller's role may not see. It names no id, so two misses read the same.
 */
const CONNECTION_NOT_FOUND_MESSAGE = "Connection not found: it does not exist or is not granted to you";

/** The refusal of a connection the caller supplied that is not an object, or whose name is not text. */
const INVALID_CONNECTION_MESSAGE = "Valid connection configuration is required";

/** Where a uniform miss is recorded: a phase of the request, as the MCP audit names its phases, never a URL. */
const GOVERNED_MISS_TARGET = "governance/connection";
const REVIEWED_MISS_TARGET = "kubernetes-access/connection";

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
 * The audit line of a uniform miss, under governance or the Kubernetes access review, which is the only record of one:
 * the 404 it answers is the same for every miss.
 *
 * METERED on the `anon` bucket and keyed on the username, as `auditRoleDenial` in src/lib/api/require-session.ts is
 * and for its reason: a signed-in session can probe ids in a loop, and every line would fill a container log volume
 * and push real events out of the ring the admin UI reads. The refusal is unconditional; only its record is bounded.
 * Isolated in its own try/catch, so a broken audit sink never turns the decided 404 into a 500.
 */
function auditUniformMiss(seedId: string, username: string, target: string): void {
  const notice = consumeRateLimit("anon", username);
  if (!notice.allowed && !notice.tripped) return;
  try {
    emitAuditEvent({
      type: "permission_denied",
      action: "denied",
      target,
      user: username,
      result: "failure",
      reason: "connection_not_granted",
      connectionName: seedId,
    });
  } catch (auditError) {
    logger.error("Failed to record permission_denied audit event", auditError, { route: "seed/resolve-connection" });
  }
}

/** A request's body as the resolve reads it. */
export type ConnectionBody = { connection?: DatabaseConnection; connectionId?: string };

/** A connection a request names, resolved, and the server catalog's record of its engine. */
export interface ResolvedConnection {
  readonly connection: EngineConnection;
  readonly engine: EngineRecord;
}

/**
 * The id a request names: its `connectionId`, else the `seed:` id its inline record claims, else nothing.
 *
 * THE `seed:` NAMESPACE IS THE OPERATOR'S, AND A CALLER MAY NOT CLAIM INTO IT (GHSA-3wh2-8x78-jfw4 root cause 2).
 *
 * An inline `connection` used to be returned verbatim, id included, while the role filter, which
 * `resolveSeedConnection` applies, guarded only the `connectionId` path. So the same managed connection was reachable
 * two ways and only one of them was checked: a `user` account posting a connection object that CLAIMED
 * `seed:admin-only` skipped the filter entirely. It is one namespace with one gate now - a claimed seed id is resolved
 * from the operator's config, exactly as if it had arrived as `connectionId`, and the caller's own copy of the record
 * is discarded.
 *
 * An id outside the namespace is a user's own saved connection and stays untouched: those carry the caller's own
 * credentials and are not what the role filter is about.
 *
 * @throws {SeedConnectionError} 400 when the `connectionId` or the inline record's id is present and not a non-empty
 * string.
 */
function requestedConnectionId({ connection, connectionId }: ConnectionBody): string | undefined {
  // A present id must be a non-empty string: an empty one is falsy but not nullish, so `??` below
  // would keep it and drop the inline record's seed claim, handing the caller's copy back verbatim.
  if (connectionId != null && (typeof connectionId !== "string" || connectionId === "")) {
    throw new SeedConnectionError("Invalid connection ID format", 400);
  }
  // A present inline id must be a string too: a number or an array reached `startsWith` below and
  // answered 500 with the runtime's own TypeError.
  if (connection?.id != null && typeof connection.id !== "string") {
    throw new SeedConnectionError("Invalid connection ID format", 400);
  }
  const claimedSeedId = connection?.id?.startsWith("seed:") ? connection.id : undefined;
  return connectionId ?? claimedSeedId;
}

/**
 * Refuses a connection the caller supplied while the operator forbids them (ALLOW_CUSTOM_CONNECTIONS).
 *
 * `resolveInlineConnection` is the one place an inline connection becomes a provider's input: every route under
 * src/app/api/db reaches its provider through `resolveServedConnection`, directly or through `handleObjectRequest`, and
 * so does the admin fleet health check. Refusing there, before the record is handed back, is what makes the switch a
 * server rule rather than a hidden button: a Studio that shares an overlay network with other services would otherwise
 * let any signed-in account open a connection to any host that network reaches.
 *
 * Only the caller's own connections are refused. A `seed:` id, arriving as `connectionId` or as the id of an inline
 * record, is resolved from the operator's file by `resolveSeedConnection` and is untouched by the switch. That is what
 * keeps an unmanaged seed's editable copy working: it keeps its `seed:<id>` id, and the server never used the copy's
 * fields in the first place.
 *
 * @throws {SeedConnectionError} 403 with CUSTOM_CONNECTIONS_DISABLED while the switch is off, after a warning line.
 */
function refuseCustomConnection(session: Principal): void {
  if (!customConnectionsAllowed()) {
    logger.warn("Custom connection refused", {
      route: "seed/resolve-connection",
      user: session.username,
      role: session.role,
    });
    throw new SeedConnectionError(CUSTOM_CONNECTIONS_DISABLED_MESSAGE, 403, ApiErrorCode.CUSTOM_CONNECTIONS_DISABLED);
  }
}

/**
 * Refuses a connection the caller supplied that sets a field only the operator's seed file sets.
 *
 * Read roots bound what agent mode and MCP read on OPC UA, and only the operator's seed file declares them. No inline
 * connection reaches an agent execution profile or MCP today, so this guards no agent path: it tells a client that
 * writes the field that it binds nothing, rather than drop it in silence and let the client believe a root it wrote
 * bounds an agent, and it keeps a later surface that admits an inline connection on an agent path from inheriting
 * roots from a caller.
 *
 * The other seed-only fields (`SEED_ONLY_FIELD_NAMES`), OPC UA's policy URI and its client certificate and private key
 * paths, are deployment facts the operator's seed file names: the paths name files on Studio's own host. A connection a
 * browser or a client supplies is refused by name when it sets one, `null` and an empty string included, the first in
 * that list order. A `seed:` id is resolved from the file by `resolveSeedConnection`, the caller's copy discarded.
 *
 * @throws {SeedConnectionError} 400 naming the first seed-only field the connection sets, `agentReadRoots` first.
 */
function refuseSeedOnlyFields(connection: DatabaseConnection): void {
  if (connection.agentReadRoots !== undefined) {
    throw new SeedConnectionError(
      "agentReadRoots is set only on a seed connection, by the operator's seed file: a connection a browser or a client supplies cannot declare what agent mode and MCP read. Remove agentReadRoots from this connection.",
      400,
    );
  }
  const seedOnly = SEED_ONLY_FIELD_NAMES.find((field) => field !== "agentReadRoots" && connection[field] !== undefined);
  if (seedOnly !== undefined) {
    throw new SeedConnectionError(
      `${seedOnly} is set only on a seed connection, by the operator's seed file: a connection a browser or a client supplies cannot set it. Remove ${seedOnly} from this connection.`,
      400,
    );
  }
}

/**
 * The server catalog's record of the engine a connection the caller supplied names, once the record is one.
 *
 * A connection that is not an object names nothing; a record whose `type` is missing, empty, not a string, or a string
 * that is not exactly a type id names no provider; and one whose `name` is present and not a string, `null` included,
 * names nothing a person can read. The factory logs both fields with a string method and the cache key frames the
 * type, so a route that handed such a record on answered 500 with the runtime's own TypeError, built a `null` name as
 * an empty one, or read the default grammar for a type no provider has. Refused here instead, so every route that
 * resolves a caller's connection answers it with one 400 before any registry is read or any provider built: the type
 * with `UnknownProviderError`, which names it (FND-1), the rest in the sentence `POST /api/db/provider-meta` refused a
 * missing type with. A claimed seed id is resolved by `resolveSeedConnection`, which refuses a seed whose type names no
 * provider itself, after its access decision.
 *
 * @throws {SeedConnectionError} 400 when the connection is not an object, or its name is present and not text.
 * @throws {UnknownProviderError} When the type is absent, not text, or names no provider (checked between the two).
 * @throws {ProviderUnavailableError} When the type is an engine only refused provider packages name.
 */
function inlineEngineRecord(connection: DatabaseConnection): EngineRecord {
  if (typeof connection !== "object" || Array.isArray(connection)) {
    throw new SeedConnectionError(INVALID_CONNECTION_MESSAGE, 400);
  }
  const engine = servedEngineRecord(connection.type);
  const name: unknown = connection.name;
  if (name !== undefined && typeof name !== "string") {
    throw new SeedConnectionError(INVALID_CONNECTION_MESSAGE, 400);
  }
  return engine;
}

/**
 * A connection the caller supplied, which names no `seed:` id, resolved: the operator's switch first, then the
 * seed-only fields, then the record and its engine, so a malformed record gets the refusal of the first rule it breaks.
 *
 * @throws {SeedConnectionError} From `refuseCustomConnection`, `refuseSeedOnlyFields` or `inlineEngineRecord`.
 * @throws {UnknownProviderError} From `inlineEngineRecord`.
 * @throws {ProviderUnavailableError} From `inlineEngineRecord`.
 */
function resolveInlineConnection(connection: DatabaseConnection, session: Principal): ResolvedConnection {
  refuseCustomConnection(session);
  refuseSeedOnlyFields(connection);
  const engine = inlineEngineRecord(connection);
  // `managed` is the operator's grant (BigQuery and Firestore read it to use server credentials).
  return { connection: { ...connection, managed: false }, engine };
}

/**
 * The refusal of a `seed:` id the caller may not open, for the caller to throw.
 *
 * UNDER GOVERNANCE OR THE KUBERNETES ACCESS REVIEW, ONE ANSWER FOR EVERY MISS, AND NO LOOKUP TO TELL THEM APART. The
 * 403 answered with both off confirms that an id exists for someone, which is exactly what a caller probing a catalog
 * of governed or reviewed connections must not learn, so an id that does not exist and one granted to another
 * subject, or one the review keeps from the caller, answer the same 404, decided from what the caller may see alone.
 * The audit line is where an operator sees which id was asked for.
 *
 * With both off, a 403 for an id the seed file lists for another role, after a warning line, and a 404 for one it does
 * not list.
 */
async function seedMissRefusal(seedId: string, session: Principal): Promise<SeedConnectionError> {
  if (governanceEnabled() || accessReviewEnabled()) {
    auditUniformMiss(seedId, session.username, governanceEnabled() ? GOVERNED_MISS_TARGET : REVIEWED_MISS_TARGET);
    return new SeedConnectionError(CONNECTION_NOT_FOUND_MESSAGE, 404, ApiErrorCode.CONNECTION_NOT_FOUND);
  }
  const exists = await getSeedConnectionByIdUnfiltered(seedId);
  if (exists) {
    logger.warn("Seed connection access denied", {
      route: "seed/resolve-connection",
      connectionId: seedId,
      user: session.username,
      role: session.role,
    });
    return new SeedConnectionError(
      `Access denied: connection "${seedId}" not available for role "${session.role}"`,
      403,
    );
  }
  return new SeedConnectionError(`Seed connection "${seedId}" not found`, 404);
}

/**
 * The operator's `seed:` entry a request names, after the access decision and with its Vault references read, with the
 * server catalog's record of its engine.
 *
 * @throws {SeedConnectionError} 400 when the id is outside the `seed:` namespace; the refusal of `seedMissRefusal` when
 * the caller may not open it; the dispatcher's 503 while a governance snapshot cannot be served.
 * @throws {UnknownProviderError} When the entry's type names no provider.
 * @throws {ProviderUnavailableError} When the entry's type is an engine only refused provider packages name.
 */
async function resolveSeedConnection(
  effectiveId: string,
  session: Principal,
  options?: VisibilityOptions,
): Promise<ResolvedConnection> {
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

  if (!seedConn) throw await seedMissRefusal(seedId, session);

  // After the access decision, so a caller who may not see the entry gets the same 403 or 404 as for any seed and
  // never learns its type; before the literal check and Vault, so nothing of an entry whose type names no provider
  // this Studio has (FND-1) is resolved or handed on. The seed file lists such an entry, and it is refused here by
  // the sentence that names its type, on every route that opens a connection.
  const engine = servedEngineRecord(seedConn.type);

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
  if (seedConn.literal) return { connection: seedConn, engine };

  // After the access decision, never before it: a `${vault:...}` reference is read here,
  // for this one connection. The list path handed it back unresolved, so listing
  // connections never reads a secret.
  return { connection: await resolveVaultCredentials(seedConn), engine };
}

/**
 * The connection a request names, resolved under `session`: an inline record of the caller's own, or the operator's
 * `seed:` entry, after the access decision and with its Vault references read, with the server catalog's record of its
 * engine. It is the one resolve of every request that names a connection (docs/providers/CONTRACT.md, clause C-107).
 * What it returns carries the type of an engine the server catalog serves, a legacy engine's or a provider package's,
 * since the inline and the seed resolve both read the type through `servedEngineRecord` (src/lib/db/server-catalog.ts)
 * and refuse every other value (FND-1), so a caller reads what the record offers, never who serves it, without a check
 * of its own.
 *
 * @throws {UnknownProviderError} When the inline record's type is absent, not text, or names no provider, or the seed
 * entry's type names no provider. A seed type that is absent, not text, or text of another shape than a type id's
 * fails the whole seed file before this resolves.
 * @throws {ProviderUnavailableError} When the type is an engine only refused provider packages name.
 * @throws {SeedConnectionError} When the request names no connection, names one the caller may not open, or carries a
 * record that is not one.
 */
export async function resolveServedConnection(
  body: ConnectionBody,
  session: Principal,
  /** Which credential a governed connection carries (src/lib/governance/visible.ts); nothing without governance. */
  options?: VisibilityOptions,
): Promise<ResolvedConnection> {
  const { connection } = body;
  const effectiveId = requestedConnectionId(body);
  if (connection && !effectiveId) return resolveInlineConnection(connection, session);
  if (effectiveId) return resolveSeedConnection(effectiveId, session, options);
  throw new SeedConnectionError("Either connection or connectionId is required", 400);
}
