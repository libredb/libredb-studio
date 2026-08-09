import { NextResponse } from "next/server";
import { getOrCreateProvider, type MaintenanceType } from "@/lib/db";
import { emitAuditEvent } from "@/lib/audit";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  // Session, rate limit and denial audit share the same door as every other provider-reaching
  // route, on the "query" bucket: an admin session is still one identity, and a stolen or
  // careless one hammering maintenance operations is the exact threat this guard exists to stop.
  // Authentication now yields 401 (was folded into a blanket 403 before); role is checked
  // separately below so "no session" and "wrong role" stay distinguishable, matching every
  // other guarded route's contract.
  const guard = await guardRoute({ route: "POST /api/db/maintenance", bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { type, target } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!type) {
      return NextResponse.json({ error: "Maintenance type is required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    const capabilities = provider.getCapabilities();

    if (!capabilities.supportsMaintenance) {
      return NextResponse.json({ error: `Maintenance operations not supported for this database` }, { status: 400 });
    }

    if (!capabilities.maintenanceOperations.includes(type as MaintenanceType)) {
      return NextResponse.json(
        {
          error: `Operation '${type}' not supported for this database. Supported: ${capabilities.maintenanceOperations.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const startTime = Date.now();
    const result = await provider.runMaintenance(type, target);
    const duration = Date.now() - startTime;

    // Isolated in its own try/catch: runMaintenance() above has already succeeded and its result
    // is already decided by the time this runs, so a broken audit sink must never turn a
    // completed maintenance operation into a 500 that invites the client to retry it - the outer
    // catch below is for failures of the operation itself, not for failures to record it.
    try {
      emitAuditEvent({
        type: type === "kill" ? "kill_session" : "maintenance",
        action: type.toUpperCase(),
        target: target || "all",
        connectionName: connection.name || connection.database || "unknown",
        user: guard.session.username || "admin",
        result: "success",
        duration,
      });
    } catch (auditError) {
      logger.error("Failed to record maintenance audit event", auditError, { route: "POST /api/db/maintenance" });
    }

    return NextResponse.json(result);
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/maintenance" });
  }
}
