import { NextRequest, NextResponse } from "next/server";
import type { MonitoringOptions } from "@/lib/db/types";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub, scrubMonitoringData } from "@/lib/db/operations/provider-text";
import { INVALID_REQUEST_BODY, isJsonObject } from "@/lib/api/json-object-body";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { metadataProvider } from "@/lib/api/editor-provider";
import { governanceEnabled } from "@/lib/governance/config";
import { packageAnswers } from "@/lib/api/package-errors";
import { monitoringOptionsRefusal, providerMonitoring } from "@/lib/api/provider-monitoring";
import { providerMonitoringTarget } from "@/lib/api/session-target";
import { servedEngineRecord } from "@/lib/db/server-catalog";

/**
 * POST /api/db/monitoring
 * Get comprehensive monitoring data for a database connection: every panel read through the host core's panel calls
 * by `providerMonitoring` (docs/providers/CONTRACT.md, clause C-74), each under its own deadline and the request's
 * signal, so a request that leaves answers 499 `QUERY_CANCELLED` and a read past its deadline 504. The panels are read
 * on the connection's metadata session (clause C-66), never behind the editor's statements.
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

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
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
    const connection = await resolveConnection(body, guard.session);
    scrub = providerTextScrub(connection, "any");

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    // The panels run on the connection's metadata session (docs/providers/CONTRACT.md, clause C-66), so a dashboard
    // never waits for a connection the editor's statements hold.
    const provider = await metadataProvider(guard.session, connection, requestCatalog(body));
    const monitoringData = await providerMonitoring(
      providerMonitoringTarget(provider),
      packageAnswers(servedEngineRecord(connection.type), scrub, "api/db/monitoring"),
      req.signal,
    ).readDashboard(options ?? {});
    // The maintenance this connected server accepts (#1387). Read here, off the provider the
    // panels came from, because `POST /api/db/provider-meta` never connects and can only answer
    // the type id's declaration, which offers PostgreSQL's and MySQL's whole sets to every
    // wire-compatible engine.
    const { maintenanceOperations, maintenanceOperationSpecs } = provider.getCapabilities();

    // A failed panel's sentence is the engine's own, answered through the connection's scrub.
    return NextResponse.json({
      ...scrubMonitoringData(scrub, monitoringData),
      maintenance: {
        maintenanceOperations,
        ...(maintenanceOperationSpecs === undefined ? {} : { maintenanceOperationSpecs }),
      },
    });
  } catch (error) {
    // A request that left answers 499 by the request's own signal, through the facade's `QueryCancelledError`; a
    // provider error answers by its class, whatever its words.
    return createErrorResponse(error, { route: "api/db/monitoring", scrub });
  }
}
