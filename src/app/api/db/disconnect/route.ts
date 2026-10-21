import { NextRequest, NextResponse } from "next/server";
import { editorCacheKey, removeProvider } from "@/lib/db/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext, sessionOwner } from "@/lib/api/execution-context";
import type { UserPayload } from "@/lib/auth";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { logger } from "@/lib/logger";

/** The namespace `resolveConnection` fills from the operator's configuration (src/lib/seed/resolve-connection.ts). */
const SEED_NAMESPACE = "seed:";

/**
 * Removes the providers of `connectionId` that the caller's disconnect may remove, and nothing else.
 *
 * Under governance every user's providers are their own (docs/GOVERNANCE.md#per-user-providers), so the caller's
 * disconnect removes only the caller's: the owner the editor context names, the session's identity provider subject.
 *
 * Without governance every caller of a connection shares its provider, so there is no owner to scope by, and removing
 * every provider of the id would let any signed-in user tear down other users' providers and SSH tunnels by naming it
 * (docs/SECURITY.md, note 0.9). A connection of the user's own is resolved from the record the request carries, as
 * every route resolves it, and only the entries its own provider key names go, the editor's and the execution profiles'
 * (`removeProvider`): the key frames the server and the credentials, so a record naming another user's connection id
 * names entries of its own. A `seed:` id removes nothing, because one provider serves every user of that seed, and the
 * idle sweep reclaims it.
 *
 * Answers whether it asked the factory to remove anything, so the route logs what the disconnect did.
 */
async function removeCallersProviders(
  body: Parameters<typeof resolveConnection>[0],
  connectionId: string,
  session: UserPayload,
): Promise<boolean> {
  const owner = sessionOwner(session);
  if (owner !== undefined) {
    await removeProvider(connectionId, { owner });
    return true;
  }
  if (connectionId.startsWith(SEED_NAMESPACE)) return false;
  const connection = await resolveConnection(body, session);
  const key = await editorCacheKey(connection, editorExecutionContext(session, connection));
  await removeProvider(connection.id, { key });
  return true;
}

export async function POST(req: NextRequest) {
  // Shares the query bucket: a disconnect is cheap on its own, but rotating to it must not be a
  // way to keep hammering the provider layer after the query budget is spent.
  const guard = await guardRoute({ route: "POST /api/db/disconnect", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ success: false, error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    // A managed connection is named by its seed id and a connection of the user's own by its record, as the editor
    // sends them to every route; the record carries its own id.
    const connectionId: unknown = body.connectionId ?? (body.connection as { id?: unknown } | null | undefined)?.id;

    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json(
        { success: false, error: "Either connection or connectionId is required" },
        { status: 400 },
      );
    }

    if (await removeCallersProviders(body, connectionId, guard.session)) {
      logger.info("[DB] Provider disconnected and removed from cache", { connectionId });
    } else {
      logger.info(
        "[DB] Disconnect removed nothing: one provider serves every user of a seed connection, and the idle sweep closes it",
        { connectionId },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // A refusal of the connection the request names, such as a custom connection while they are off, keeps its own
    // status and code, as on every route that resolves one.
    if (error instanceof SeedConnectionError) return createErrorResponse(error, { route: "api/db/disconnect" });
    logger.error("[DB] Error disconnecting provider", error, { route: "POST /api/db/disconnect" });
    return NextResponse.json({ success: false, error: "Failed to disconnect" }, { status: 500 });
  }
}
