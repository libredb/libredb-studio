import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub } from "@/lib/db/operations/provider-text";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { metadataProvider } from "@/lib/api/editor-provider";
import { livenessResponse } from "@/lib/api/liveness";
import { providerMonitoring } from "@/lib/api/provider-monitoring";
import { providerMonitoringTarget } from "@/lib/api/session-target";
import { servedEngineRecord } from "@/lib/db/server-catalog";

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
 * Detailed health check for a specific database connection. The health is read through the monitoring facade and the
 * host core's health call (docs/providers/CONTRACT.md, clause C-75), under its own deadline, the statement timeout
 * plus 10 s, and the request's signal, on the connection's metadata session (clause C-66), never behind the editor's
 * statements.
 */
export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/health", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    const connection = await resolveConnection(body, guard.session);
    scrub = providerTextScrub(connection, "any");

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    // The health read runs on the connection's metadata session (docs/providers/CONTRACT.md, clause C-66), so the
    // connection pulse never waits for a connection the editor's statements hold.
    const provider = await metadataProvider(guard.session, connection, requestCatalog(body));
    const health = await providerMonitoring(
      providerMonitoringTarget(provider),
      servedEngineRecord(connection.type),
      scrub,
      req.signal,
      "api/db/health",
    ).readHealth();

    return NextResponse.json(health);
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/health", scrub });
  }
}
