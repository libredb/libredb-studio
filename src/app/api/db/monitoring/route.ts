import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import type { MonitoringOptions } from "@/lib/db/types";
import { createErrorResponse } from "@/lib/api/errors";
import { INVALID_REQUEST_BODY, isJsonObject } from "@/lib/api/json-object-body";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";
import { governanceEnabled } from "@/lib/governance/config";

/**
 * POST /api/db/monitoring
 * Get comprehensive monitoring data for a database connection
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
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }

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

    const connection = await resolveConnection(body, guard.session);
    const { options } = body as { options?: MonitoringOptions };

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await editorProvider(guard.session, connection, requestCatalog(body));
    const monitoringData = await provider.getMonitoringData(options);
    // The maintenance this connected server accepts (#1387). Read here, off the provider the
    // panels came from, because `POST /api/db/provider-meta` never connects and can only answer
    // the type id's declaration, which offers PostgreSQL's and MySQL's whole sets to every
    // wire-compatible engine.
    const { maintenanceOperations, maintenanceOperationSpecs } = provider.getCapabilities();

    return NextResponse.json({
      ...monitoringData,
      maintenance: {
        maintenanceOperations,
        ...(maintenanceOperationSpecs === undefined ? {} : { maintenanceOperationSpecs }),
      },
    });
  } catch (error) {
    // Ignore aborted requests (client cancelled)
    if (
      error instanceof Error &&
      (error.message === "aborted" ||
        error.name === "AbortError" ||
        (error as NodeJS.ErrnoException).code === "ECONNRESET")
    ) {
      return new Response(null, { status: 499 }); // Client Closed Request
    }

    return createErrorResponse(error, { route: "api/db/monitoring" });
  }
}
