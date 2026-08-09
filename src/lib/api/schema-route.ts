import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import type { DatabaseProvider } from "@/lib/db/types";

/**
 * Shared request handling for the schema introspection routes
 * (/api/db/schema/list and /api/db/schema/relations). Both perform the same
 * body parsing, auth, connection resolution and error mapping; only the
 * provider call differs, supplied via `load`.
 *
 * Fixing the guard once here, rather than in each caller, is what keeps both routes on the
 * `query` bucket in lockstep: `route` (e.g. "api/db/schema/list") is the same string both
 * callers already pass for error-response context, so `POST /${route}` reuses it rather than
 * threading a second, guard-specific string through both call sites.
 */
export async function handleSchemaRequest(
  req: NextRequest,
  route: string,
  load: (provider: DatabaseProvider) => Promise<unknown>,
): Promise<NextResponse> {
  // Moved ahead of body parsing: an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    const connection = await resolveConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    return NextResponse.json(await load(provider));
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
