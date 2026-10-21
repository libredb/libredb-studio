import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";
import { livenessResponse } from "@/lib/api/liveness";

/**
 * GET /api/db/health
 *
 * Liveness, for anything already pointed here. `/health` and `/api/health` answer the same
 * thing (#909); the body is built in one place so the three cannot drift.
 */
export function GET() {
  return livenessResponse();
}

/**
 * POST /api/db/health
 * Detailed health check for a specific database connection
 */
export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/health", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    const connection = await resolveConnection(body, guard.session);

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await editorProvider(guard.session, connection, requestCatalog(body));
    const health = await provider.getHealth();

    return NextResponse.json(health);
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/health" });
  }
}
