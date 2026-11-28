import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { metadataMonitoringTarget } from "@/lib/api/editor-provider";
import { livenessResponse } from "@/lib/api/liveness";
import { type PackageAnswers, packageAnswers } from "@/lib/api/package-errors";
import { providerMonitoring } from "@/lib/api/provider-monitoring";
import { legacyProviderType } from "@/lib/db/server-catalog";

const ROUTE = "api/db/health";

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
 * plus 10 s, and the request's signal, on the record's metadata session (clause C-66), never behind the editor's
 * statements, for any engine the server serves: a legacy provider's bridged session or a provider package's own
 * (clause C-107). A catalog the record does not offer is refused by name before any open (clause C-111). A package's
 * failure, of its open or of the read, is answered and logged once through the request's `PackageAnswers` (clause
 * C-112), so the route writes no second line for it.
 */
export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/health", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection and the request's record of a package's failures, held out here for the
  // `catch` below: before the connection resolves no provider ran.
  let scrub: ProviderTextScrub | undefined;
  let answers: PackageAnswers | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    const { connection, engine } = await resolveServedConnection(body, guard.session);
    scrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
    answers = packageAnswers(engine, scrub, ROUTE);
    const opening = answers;

    // The health read runs on the record's metadata session (docs/providers/CONTRACT.md, clause C-66), so the
    // connection pulse never waits for a connection the editor's statements hold. A failure of the open is the
    // package's open's.
    const target = await metadataMonitoringTarget(guard.session, connection, engine, requestCatalog(body)).catch(
      (error: unknown) => {
        throw opening.answer("open", error);
      },
    );
    const health = await providerMonitoring(target, answers, req.signal).readHealth();

    return NextResponse.json(health);
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE, scrub, logged: answers?.logged(error) === true });
  }
}
