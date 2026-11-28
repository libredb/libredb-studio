import { NextResponse } from "next/server";
import { scrubMaintenancePreview } from "@/lib/db/operations/provider-text";
import { maintenanceControl } from "@/lib/db/types";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { handleMaintenanceRequest, type MaintenanceRouteForm } from "@/lib/api/maintenance-route";
import { providerMaintenance } from "@/lib/api/provider-maintenance";

const ROUTE = "POST /api/db/maintenance/preview";

/** The preview's form of the shared path: a non-empty `target` naming one object; every operation on the editor's session. */
const PREVIEW: MaintenanceRouteForm<string> = {
  route: ROUTE,
  errorRoute: "api/db/maintenance/preview",
  readTarget: (target) =>
    typeof target !== "string" || target === ""
      ? { refusal: `"target" must name the object the operation would run on` }
      : { target },
  killOnMetadata: false,
};

/**
 * What one per-object maintenance operation will do, read for the admin about to confirm it (spec 3.11).
 *
 * A read, and still a route on the credential path, so it stands behind the same doors as `POST /api/db/maintenance`:
 * the same `guardRoute` bucket, the admin check with its audited denial, and the request checks that route makes
 * before it runs anything, one path both routes call (`handleMaintenanceRequest` in src/lib/api/maintenance-route.ts),
 * so the two cannot disagree about a request: the connection and the record of its engine (`resolveServedConnection`), for any engine the server serves (docs/providers/CONTRACT.md,
 * clause C-107), `type` present and text, `container` text or absent, the operation listed in the record's maintenance
 * before any session opens (`400 FACET_NOT_OFFERED`, outcome not-sent), a catalog the record does not offer refused by
 * name before any open (clause C-111), and the operation the opened session's server accepts (the same code and outcome,
 * before any call). A preview is per object, so a non-empty `target` is required where the maintenance route reads its
 * absence as the whole-database form.
 *
 * Neither route proves that the target exists, because neither calls the provider before its one method: existence is
 * the provider's, and `previewMaintenance` raises a `QueryError` naming what is missing. Nothing but that method is
 * called, and no audit row is written for a preview answered, because a preview changes nothing.
 *
 * The preview goes through the host core (docs/providers/CONTRACT.md, clause C-70): after those checks the route builds
 * the opening's target on the editor's session, which for a legacy provider reads its declarations, and reads the
 * preview through `providerMaintenance`, on the session's maintenance, until the statement timeout plus ten seconds and
 * until the request leaves, answering 499 or 504 when either ends the wait first. Whether a preview is offered is the
 * session's offer. A raw error the provider raises answers 500 `INTERNAL_ERROR`, unmapped: the one preview Studio
 * ships answers Studio's own classes. A package's failure, of its open or of the preview, is answered and logged once
 * through the request's `PackageAnswers` (clause C-112), and the preview's sentences reach the client under the
 * record's grant of its words.
 */
export async function POST(request: Request) {
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: ROUTE, user: guard.session.username, request });
    return adminRequiredResponse();
  }

  return await handleMaintenanceRequest(request, guard.session, PREVIEW, async (served) => {
    const { type, target, container: requestedContainer, answers, words } = served;
    const capabilities = served.accepted;

    // The maintenance route's placement gate, for the one placement a preview has: a named object. It speaks only
    // where the provider offers the other placement, which is that route's reading of a spec with both halves false.
    const perEntityControl = maintenanceControl(capabilities, type, "perEntity");
    const globalControl = maintenanceControl(capabilities, type, "global");
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

    // The target the preview is read on, built only now the checks above passed, as the maintenance route builds it.
    const maintenance = providerMaintenance(await served.opened.target(), answers, request.signal);

    // A session whose spec declares a preview and that does not offer `maintenance.preview`: a legacy provider that
    // holds no `previewMaintenance`, or a package that does not offer it, or withdrew it at its open.
    if (!maintenance.previewOffered) {
      return NextResponse.json({ error: "This operation has no preview" }, { status: 400 });
    }

    // The object's path, container levels then the object (spec 3.11): one container level is all this body names.
    const path = requestedContainer === undefined ? [target] : [requestedContainer, target];
    const preview = await maintenance.preview(type, path);
    return NextResponse.json({ preview: scrubMaintenancePreview(words, preview) });
  });
}
