import { NextRequest, NextResponse } from "next/server";
import type { MonitoringOptions } from "@/lib/db/types";
import { createErrorResponse } from "@/lib/api/errors";
import { connectionTextScrub, type ProviderTextScrub, scrubMonitoringData } from "@/lib/db/operations/provider-text";
import { INVALID_REQUEST_BODY, isJsonObject } from "@/lib/api/json-object-body";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { metadataMonitoringTarget } from "@/lib/api/editor-provider";
import { governanceEnabled } from "@/lib/governance/config";
import { type PackageAnswers, packageAnswers } from "@/lib/api/package-errors";
import { monitoringOptionsRefusal, providerMonitoring } from "@/lib/api/provider-monitoring";
import { legacyProviderType } from "@/lib/db/server-catalog";

const ROUTE = "api/db/monitoring";

/**
 * POST /api/db/monitoring
 * Get comprehensive monitoring data for a database connection: every panel read through the host core's panel calls
 * by `providerMonitoring` (docs/providers/CONTRACT.md, clause C-74), each under its own deadline and the request's
 * signal, so a request that leaves answers 499 `QUERY_CANCELLED` and a read past its deadline 504. The panels are read
 * on the record's metadata session (clause C-66), never behind the editor's statements, for any engine the server
 * serves: a legacy provider's bridged session or a provider package's own (clause C-107). A catalog the record does
 * not offer, and a session that does not offer `monitoring.panel`, are refused by name before any call (clause C-111).
 * A package's failure, of its open or of a read, is answered and logged once through the request's `PackageAnswers`
 * (clause C-112), so the route writes no second line for it, and the two sentences a panel answer writes, the
 * overview's table count sentence and the cache advice, reach the client under the record's grant of its words.
 */
export async function POST(req: NextRequest) {
  // Moved ahead of body parsing, matching every other provider-reaching route: an unauthenticated
  // or rate-limited caller no longer gets a body parsed on its behalf, and gets the promised
  // denial audit instead of a 400 that never reached the guard.
  const guard = await guardRoute({ route: "POST /api/db/monitoring", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Under governance (docs/GOVERNANCE.md#grants-and-the-connection-list) users who share a read principal would see
  // each other's statements in `pg_stat_activity`, so monitoring is admin-only there. The refusal comes before the body
  // is read and before a connection is resolved, and is audited as the maintenance route's is. Without governance every
  // session keeps the access it always had.
  if (governanceEnabled() && guard.session.role !== "admin") {
    auditRoleDenial({ route: "POST /api/db/monitoring", user: guard.session.username, request: req });
    return adminRequiredResponse();
  }

  // Core's scrub of the resolved connection and the request's record of a package's failures, held out here for the
  // `catch` below: before the connection resolves no provider ran.
  let scrub: ProviderTextScrub | undefined;
  let answers: PackageAnswers | undefined;
  try {
    // Handle empty or aborted requests
    let body;
    try {
      const text = await req.text();
      if (!text) {
        return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
      }
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }
    // JSON that is not an object (`null`, an array, a number) is a malformed request as well, refused before any
    // connection resolves: a `null` one answered 500 with the runtime's own destructuring error.
    if (!isJsonObject(body)) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    // A present `options` that is not an object is refused in the query route's words: a `null` one reached the
    // provider's destructuring and answered 500 with the runtime's own text.
    const { options } = body as { options?: MonitoringOptions };
    if (options !== undefined && !isJsonObject(options)) {
      return NextResponse.json({ error: "options must be an object" }, { status: 400 });
    }
    // A limit that is not a whole number from 1 to its list's answer bound, or a schema filter that is not text naming
    // a schema, is refused by name before any connection resolves: it reached the provider as it came (BigQuery's
    // `LIMIT NaN`), and the host core refuses a panel request whose limit is past that bound as a defect of Studio.
    const optionsRefusal = options === undefined ? undefined : monitoringOptionsRefusal(options);
    if (optionsRefusal !== undefined) {
      return NextResponse.json({ error: optionsRefusal }, { status: 400 });
    }
    const { connection, engine } = await resolveServedConnection(body, guard.session);
    const connectionScrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
    scrub = connectionScrub;
    answers = packageAnswers(engine, connectionScrub, ROUTE);
    const opening = answers;

    // The panels run on the record's metadata session (docs/providers/CONTRACT.md, clause C-66), so a dashboard
    // never waits for a connection the editor's statements hold. A failure of the open is the package's open's.
    const target = await metadataMonitoringTarget(guard.session, connection, engine, requestCatalog(body)).catch(
      (error: unknown) => {
        throw opening.answer("open", error);
      },
    );
    const monitoringData = await providerMonitoring(target, answers, req.signal).readDashboard(options ?? {});
    // The maintenance this connected server accepts (#1387). Read here, off the session the
    // panels came from, because `POST /api/db/provider-meta` never connects and can only answer
    // the type id's declaration, which offers PostgreSQL's and MySQL's whole sets to every
    // wire-compatible engine.
    const { maintenanceOperations, maintenanceOperationSpecs } = target.accepted();

    // A failed panel's sentence is the engine's own, answered through the connection's scrub; the overview's table count
    // sentence and the cache advice reach the client under the record's grant of its words (clause C-112).
    return NextResponse.json({
      ...scrubMonitoringData(
        { scrub: connectionScrub, ownWords: engine.grants.ownWords, route: ROUTE },
        monitoringData,
      ),
      maintenance: {
        maintenanceOperations,
        ...(maintenanceOperationSpecs === undefined ? {} : { maintenanceOperationSpecs }),
      },
    });
  } catch (error) {
    // A request that left answers 499 by the request's own signal, through the facade's `QueryCancelledError`; a
    // provider error answers by its class, whatever its words.
    return createErrorResponse(error, { route: ROUTE, scrub, logged: answers?.logged(error) === true });
  }
}
