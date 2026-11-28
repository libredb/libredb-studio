import { NextResponse } from "next/server";
import { type MaintenanceOperation, readProviderDeclarations } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub, scrubMaintenancePreview } from "@/lib/db/operations/provider-text";
import { maintenanceControl } from "@/lib/db/types";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { providerMaintenance } from "@/lib/api/provider-maintenance";
import { providerMaintenanceTarget } from "@/lib/api/session-target";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { assertMaintenanceAccepted, assertMaintenanceOffered } from "@/lib/db/engine-facets/maintenance";

const ROUTE = "POST /api/db/maintenance/preview";

/**
 * What one per-object maintenance operation will do, read for the admin about to confirm it (spec 3.11).
 *
 * A read, and still a route on the credential path, so it stands behind the same doors as `POST /api/db/maintenance`:
 * the same `guardRoute` bucket, the admin check with its audited denial, and the request checks that route makes
 * before it runs anything, in the same order, so the two cannot disagree about a request: `type` present and text,
 * `container` text or absent, the operation listed in the engine's `ENGINE_FACETS` row before any provider is built
 * (`400 FACET_NOT_OFFERED`), and the operation the connected server accepts (the same code). A preview is per object,
 * so a non-empty `target` is required where the maintenance route reads its absence as the whole-database form.
 *
 * Neither route proves that the target exists, because neither calls the provider before its one method: existence is
 * the provider's, and `previewMaintenance` raises a `QueryError` naming what is missing. Nothing but that method is
 * called, and no audit row is written for a preview answered, because a preview changes nothing.
 *
 * The preview goes through the host core (docs/providers/CONTRACT.md, clause C-70): after those checks the route reads
 * the provider's declarations and reads the preview through `providerMaintenance`, on the session's maintenance, until
 * the statement timeout plus ten seconds and until the request leaves, answering 499 or 504 when either ends the wait
 * first. Whether a preview is offered is the bridged session's offer. A raw error the provider raises answers 500
 * `INTERNAL_ERROR`, unmapped: the one preview Studio ships answers Studio's own classes.
 */
export async function POST(request: Request) {
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: ROUTE, user: guard.session.username, request });
    return adminRequiredResponse();
  }

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not JSON, or JSON that is not an object (`null`, an array, a number), is the caller's mistake and
    // answers 400 in a fixed sentence, rather than reaching the destructuring below as a raw runtime error.
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { type, target, container } = body;

    const connection = await resolveConnection(body, guard.session);
    scrub = providerTextScrub(connection, "any");

    if (!type) {
      return NextResponse.json({ error: "Maintenance type is required" }, { status: 400 });
    }

    // The maintenance route's type rule: an operation is named by text, and a value that is not text is not repeated.
    if (typeof type !== "string") {
      return NextResponse.json({ error: `"type" must be a string naming a maintenance operation` }, { status: 400 });
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

    // The maintenance route's two operation checks: the engine facets row before any provider is built, and the
    // connected server's declaration after, each refused 400 FACET_NOT_OFFERED.
    assertMaintenanceOffered(connection.type, type);

    const provider = await editorProvider(guard.session, connection, requestCatalog(body));
    const capabilities = provider.getCapabilities();

    assertMaintenanceAccepted(connection.type, type, capabilities);

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
    if (!perEntityControl.offered || perEntityControl.preview !== true) {
      return NextResponse.json({ error: "This operation has no preview" }, { status: 400 });
    }

    // The provider's maintenance as declared before it connects, read as the maintenance route reads it.
    const { capabilities: declared } = await readProviderDeclarations(
      connection,
      editorExecutionContext(guard.session, connection),
    );
    const maintenance = providerMaintenance(
      providerMaintenanceTarget(provider, declared),
      servedEngineRecord(connection.type),
      scrub,
      request.signal,
      ROUTE,
    );

    // A provider that declares a preview and holds no `previewMaintenance`: the bridged session does not offer one.
    if (!maintenance.previewOffered) {
      return NextResponse.json({ error: "This operation has no preview" }, { status: 400 });
    }

    // The object's path, container levels then the object (spec 3.11): one container level is all this body names.
    const path = requestedContainer === undefined ? [target] : [requestedContainer, target];
    const preview = await maintenance.preview(type as MaintenanceOperation, path);
    return NextResponse.json({ preview: scrubMaintenancePreview(scrub, preview) });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/maintenance/preview", scrub });
  }
}
