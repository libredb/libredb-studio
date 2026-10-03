import { NextResponse } from "next/server";
import { getOrCreateProvider, type MaintenanceOperation } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { maintenanceControl } from "@/lib/db/types";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";

const ROUTE = "POST /api/db/maintenance/preview";

/**
 * What one per-object maintenance operation will do, read for the admin about to confirm it (spec 3.11).
 *
 * A read, and still a route on the credential path, so it stands behind the same doors as `POST /api/db/maintenance`:
 * the same `guardRoute` bucket, the admin check with its audited denial, and the request checks that route makes
 * before it runs anything, in the same order, so the two cannot disagree about a request. A preview is per object, so
 * a non-empty `target` is required where the maintenance route reads its absence as the whole-database form.
 *
 * Neither route proves that the target exists, because neither calls the provider before its one method: existence is
 * the provider's, and `previewMaintenance` raises a `QueryError` naming what is missing. Nothing but that method is
 * called, and no audit row is written for a preview answered, because a preview changes nothing.
 */
export async function POST(request: Request) {
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: ROUTE, user: guard.session.username, request });
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { type, target, container } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!type) {
      return NextResponse.json({ error: "Maintenance type is required" }, { status: 400 });
    }

    // The maintenance route's container rule: a string or absent, and an empty string is the absence of one.
    if (container !== undefined && typeof container !== "string") {
      return NextResponse.json(
        { error: `"container" must be a string naming the target's container` },
        { status: 400 },
      );
    }

    if (typeof target !== "string" || target === "") {
      return NextResponse.json({ error: `"target" must name the object the operation would run on` }, { status: 400 });
    }

    const requestedContainer: string | undefined = container || undefined;

    const provider = await getOrCreateProvider(connection);
    const capabilities = provider.getCapabilities();

    if (!capabilities.supportsMaintenance) {
      return NextResponse.json({ error: `Maintenance operations not supported for this database` }, { status: 400 });
    }

    if (!capabilities.maintenanceOperations.includes(type as MaintenanceOperation)) {
      return NextResponse.json(
        {
          error: `Operation '${type}' not supported for this database. Supported: ${capabilities.maintenanceOperations.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // The maintenance route's placement gate, for the one placement a preview has: a named object. It speaks only
    // where the provider offers the other placement, which is that route's reading of a spec with both halves false.
    const perEntityControl = maintenanceControl(capabilities, type as MaintenanceOperation, "perEntity");
    const globalControl = maintenanceControl(capabilities, type as MaintenanceOperation, "global");
    if (!perEntityControl.offered && globalControl.offered) {
      const name = perEntityControl.label ?? `Operation '${type}'`;
      return NextResponse.json(
        { error: `${name} takes no target on this database: it runs over the whole database. Omit 'target'.` },
        { status: 400 },
      );
    }

    // A preview belongs to the per-row dialog, so a spec that offers no row has none, whatever it declares: the
    // maintenance route lets a spec with both halves false through, and this route does not follow it there.
    if (!perEntityControl.offered || perEntityControl.preview !== true || provider.previewMaintenance === undefined) {
      return NextResponse.json({ error: "This operation has no preview" }, { status: 400 });
    }

    // The object's path, container levels then the object (spec 3.11): one container level is all this body names.
    const path = requestedContainer === undefined ? [target] : [requestedContainer, target];
    const preview = await provider.previewMaintenance(type as MaintenanceOperation, path);
    return NextResponse.json({ preview });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/maintenance/preview" });
  }
}
