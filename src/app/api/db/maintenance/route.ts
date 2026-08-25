import { NextResponse } from "next/server";
import { getOrCreateProvider, type MaintenanceType } from "@/lib/db";
import { emitAuditEvent } from "@/lib/audit";
import { createErrorResponse } from "@/lib/api/errors";
import { maintenanceControl, type MaintenancePlacement } from "@/lib/db/types";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
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
    auditRoleDenial({ route: "POST /api/db/maintenance", user: guard.session.username, request });
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

    // `maintenanceOperations` above says only that the operation EXISTS here. What KIND of
    // target it takes is a separate declaration - `maintenanceOperationSpecs` - and until
    // U20 this route never read it, while both UI surfaces gated on it. The gap is the one
    // the U20 backlog entry reports from a live SQLite run: POST {type:"vacuum",
    // target:"users"} answered 200 and vacuumed the whole file, which is exactly the reading
    // `vacuum: { perEntity: false }` exists to withhold. What THIS change measured is
    // narrower and should not be read as that run repeated: the status code only, against
    // SQLite-SHAPED mock capabilities rather than a live engine - the request that answered
    // 200 now answers 400 and never reaches `runMaintenance`. `maintenanceControl` is asked
    // here rather than the spec read directly so the route cannot disagree with the two
    // surfaces about what a provider declared.
    //
    // A non-empty `target` is the "perEntity" request and its absence the "global" one - the
    // same reading the audit row below already uses (`target || "all"`), so `target: ""` is a
    // whole-database request, not an unnamed object.
    //
    // Both halves false is NOT "takes no target": every provider that declares `kill`
    // declares it false/false because its target is a session or query id, which neither a
    // table row nor a whole-database card can supply. The gate therefore only speaks when the
    // provider claimed at least one of the two placements it describes; otherwise the target
    // comes from somewhere this field says nothing about and the request passes through.
    //
    // The `labels.vacuumActionOperation` redirect is deliberately NOT honoured here. It is a
    // wording concern: it says which operation a provider's *vacuum* copy names, and both
    // callers (`TableItem`, `OperationsTab`) resolve it before sending - the request carries
    // the resolved operation id, never the literal `vacuum`. Rewriting a caller's stated
    // operation into a different one is the opposite of what a gate does, and it would make
    // the existing "operation not supported" 400 unreachable for exactly the four providers
    // whose vacuum wording names something else.
    const placement: MaintenancePlacement = target ? "perEntity" : "global";
    const perEntityControl = maintenanceControl(capabilities, type as MaintenanceType, "perEntity");
    const globalControl = maintenanceControl(capabilities, type as MaintenanceType, "global");
    const requestedControl = placement === "perEntity" ? perEntityControl : globalControl;

    if (!requestedControl.offered && (perEntityControl.offered || globalControl.offered)) {
      // Exactly one placement is available here (the other is the refused one), so the
      // message can name what the operation does accept, in the provider's own wording.
      //
      // The `??` is defensive against untyped capabilities, not a reachable path: entering
      // this branch requires a spec to exist for `type` - with no spec `maintenanceControl`
      // reports BOTH placements offered, so neither half of the condition holds - and
      // `MaintenanceOperationSpec.label` is a required string, so any provider that went
      // through the type carries a name here. The fallback stands only for a capabilities
      // object that reached this route without doing so, where inventing a name would put a
      // word the engine does not use in front of an operator.
      const name = requestedControl.label ?? `Operation '${type}'`;
      const error =
        placement === "perEntity"
          ? `${name} takes no target on this database: it runs over the whole database. Omit 'target'.`
          : `${name} requires a target on this database: it runs against one object at a time.`;
      return NextResponse.json({ error }, { status: 400 });
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
        // The engine's verdict, not the request's. `runMaintenance` resolving is only the
        // statement having reached the engine: since 2026-08-25 MySQL and Oracle read the
        // server's own answer, so `success: false` on a 200 is the ordinary reply for a
        // target the engine would not touch - and recording that as a completed operation
        // is worse than not recording it, because this log is where an operator
        // reconstructs what was done to a database. A provider that reports no verdict
        // keeps the old reading: only an explicit `false` is a failure.
        result: result.success === false ? "failure" : "success",
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
