import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorMonitoringTarget } from "@/lib/api/editor-provider";
import { type PackageAnswers, packageAnswers } from "@/lib/api/package-errors";
import { providerMonitoring } from "@/lib/api/provider-monitoring";
import { legacyProviderType } from "@/lib/db/server-catalog";

const ROUTE = "api/db/pool-stats";

/**
 * POST /api/db/pool-stats
 * The connection's pool statistics, read through the host core's pool statistics call by `providerMonitoring`
 * (docs/providers/CONTRACT.md, clause C-74) under its own deadline and the request's signal, on the record's editor
 * session, whose pool it reports, for any engine the server serves: a legacy provider's bridged session or a provider
 * package's own (clause C-107), where the session offers it; a session that reads no pool statistics answers zeros and
 * a sentence saying so. A catalog the record does not offer is refused by name before any open (clause C-111). A
 * package's failure, of its open or of the read, is answered and logged once through the request's `PackageAnswers`
 * (clause C-112), so the route writes no second line for it.
 */
export async function POST(request: NextRequest) {
  // Moved ahead of request.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/pool-stats", bucket: "query", request });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection and the request's record of a package's failures, held out here for the
  // `catch` below: before the connection resolves no provider ran.
  let scrub: ProviderTextScrub | undefined;
  let answers: PackageAnswers | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(request);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    const { connection, engine } = await resolveServedConnection(body, guard.session);
    scrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
    answers = packageAnswers(engine, scrub, ROUTE);
    const opening = answers;

    // A failure of the open is the package's open's.
    const target = await editorMonitoringTarget(guard.session, connection, engine, requestCatalog(body)).catch(
      (error: unknown) => {
        throw opening.answer("open", error);
      },
    );
    const monitoring = providerMonitoring(target, answers, request.signal);
    if (monitoring.poolStatsOffered) {
      return NextResponse.json(await monitoring.readPoolStats());
    }

    // A session that reads no pool statistics
    return NextResponse.json({
      total: 0,
      idle: 0,
      active: 0,
      waiting: 0,
      message: "Pool statistics not available for this provider",
    });
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE, scrub, logged: answers?.logged(error) === true });
  }
}
